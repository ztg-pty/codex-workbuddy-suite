// ZCode client request signing, reimplemented in Node from jjjane233/workbuddy-3in1
// (MIT, itself derived from Sliverkiss/workbuddy2api). Verified field-by-field
// against internal/zcode/sign.go.
//
// Two facts that matter and are easy to get wrong:
//   1. The handshake endpoint is NOT the business host. Posting /api/paas/... to
//      zcode.z.ai returns 404. Use the BigModel/Z.AI origins below.
//   2. The decrypted privateCipher is base64 *text* wrapping PKCS8, so it needs
//      a second decode. The AAD is the keyId.
import {createDecipheriv,createHash,createHmac,createPrivateKey,randomBytes,sign as edSign,verify as edVerify} from 'node:crypto';

export const SIGN_PATH='/api/paas/c1f3a7e2/v2/client';
export const SIGN_KDF_SALT='WD_CLIENT_SIGN_KDF_SALT';
export const SIGN_KDF_HMAC='getSignKey_hmac';
export const SIGN_KDF_PRIV='ed25519_priv';
export const SIGN_APP_ID='zcode';
export const SIGN_HANDSHAKE='get_sign_key';
export const SIGN_NONCE_BYTES=16;
export const SIGN_POW_NONCE_BYTES=12;
export const SIGN_DEFAULT_POW_BITS=8;
export const SIGN_HANDSHAKE_ORIGINS=['https://open.bigmodel.cn','https://api.z.ai','https://bigmodel.cn'];
export const DEFAULT_APP_VERSION='3.14.3';

export function hkdfSha256(ikm,salt,info,length){
  const prk=createHmac('sha256',salt).update(ikm).digest();
  const chunks=[];let block=Buffer.alloc(0);
  for(let counter=1;Buffer.concat(chunks).length<length;counter++){
    block=createHmac('sha256',prk).update(block).update(info).update(Buffer.from([counter])).digest();
    chunks.push(block);
  }
  return Buffer.concat(chunks).subarray(0,length);
}

// PoW seed is sha256(keyId "\n" appId "\n" sessionId "\n" ts); the first 32 hex
// chars of that digest are the prefix. Candidates are 12 random bytes plus a
// zero-padded hex counter. Separators are "\n", matching the client exactly.
export function solvePow({keyId,appId=SIGN_APP_ID,sessionId,ts,bits=SIGN_DEFAULT_POW_BITS}={}){
  const prefix=sha256Hex(`${keyId}\n${appId}\n${sessionId}\n${ts}`).slice(0,32);
  const nonce=randomBytes(SIGN_POW_NONCE_BYTES).toString('hex');
  for(let counter=0;counter<0xffffffff;counter++){
    const candidate=nonce+counter.toString(16).padStart(8,'0');
    if(hasLeadingZeroBits(Buffer.from(sha256Hex(`${prefix}\n${candidate}`),'hex'),bits))return candidate;
  }
  return undefined;
}
function sha256Hex(text){return createHash('sha256').update(text).digest('hex');}
export {sha256Hex};
export function leadingZeroBits(buffer){
  let bits=0;
  for(const byte of buffer){
    if(byte===0){bits+=8;continue;}
    for(let shift=7;shift>=0;shift--){if(byte&(1<<shift))return bits;bits++;}
    return bits;
  }
  return bits;
}
export function hasLeadingZeroBits(buffer,bits){
  const full=Math.floor(bits/8);
  for(let index=0;index<full&&index<buffer.length;index++)if(buffer[index]!==0)return false;
  const remainder=bits%8;
  if(remainder===0||full>=buffer.length)return true;
  const mask=(255<<(8-remainder))&0xff;
  return (buffer[full]&mask)===0;
}

// The canonical string signed by the Ed25519 key, newline separated.
export function canonicalString({keyId,ts,clientVersion,sessionId,nonce}){
  return `${keyId}\n${ts}\n${clientVersion}\n${sessionId}\n${nonce}`;
}

export class ZCodeSignError extends Error {
  constructor(code){super(`zcode-sign: ${code}`);this.name='ZCodeSignError';this.code=code;}
}
export function verifyRejected(body){
  const text=typeof body==='string'?body:'';
  return text.includes('VERIFY_SIGNATURE_INVALID')||text.includes('VERIFY_APIKEY_EXPIRED');
}

export function decryptPrivateCipher({keyId,secret,cipherB64}){
  const blob=Buffer.from(String(cipherB64??'').trim(),'base64');
  if(blob.length<=12+16)throw new ZCodeSignError('private-cipher-too-short');
  const key=hkdfSha256(Buffer.from(secret,'utf8'),Buffer.from(SIGN_KDF_SALT,'utf8'),Buffer.from(SIGN_KDF_PRIV,'utf8'),32);
  const iv=blob.subarray(0,12);const tag=blob.subarray(blob.length-16);const ciphertext=blob.subarray(12,blob.length-16);
  let plain;
  try{const decipher=createDecipheriv('aes-256-gcm',key,iv,{authTagLength:16});decipher.setAAD(Buffer.from(keyId,'utf8'));decipher.setAuthTag(tag);plain=Buffer.concat([decipher.update(ciphertext),decipher.final()]);}
  catch{throw new ZCodeSignError('private-cipher-decrypt-failed');}
  // The client decodes the plaintext as base64 text a second time; tolerate a
  // direct DER payload as a fallback.
  const text=plain.toString('utf8').trim();
  let der=Buffer.from(text,'base64');
  if(!der.length||!/^[0-9A-Za-z+/=\s]+$/u.test(text))der=plain;
  if(!der.length)throw new ZCodeSignError('private-key-invalid');
  return der;
}

export function createSigner({credential,clientVersion=DEFAULT_APP_VERSION,fetchImpl=fetch,appId=SIGN_APP_ID,origins=SIGN_HANDSHAKE_ORIGINS}={}){
  const dot=typeof credential==='string'?credential.indexOf('.'):-1;
  if(dot<=0||dot===credential.length-1)throw new ZCodeSignError('credential-invalid');
  const keyId=credential.slice(0,dot);
  const secret=credential.slice(dot+1);
  let privateKey=null;let handshakeOrigin=null;let powBits=SIGN_DEFAULT_POW_BITS;

  const handshake=async({signal}={})=>{
    const ts=String(Date.now());
    const nonce=randomBytes(SIGN_NONCE_BYTES).toString('hex');
    const hmacKey=hkdfSha256(Buffer.from(secret,'utf8'),Buffer.from(SIGN_KDF_SALT,'utf8'),Buffer.from(SIGN_KDF_HMAC,'utf8'),32);
    const mac=createHmac('sha256',hmacKey).update(`${SIGN_HANDSHAKE}\n${keyId}\n${ts}\n${nonce}`).digest('base64');
    const body=JSON.stringify({apiKey:`${keyId}.${secret}`,nonce,sig:mac,ts});
    let lastError='handshake-failed';
    for(const origin of origins){
      let response;try{
        response=await fetchImpl(origin+SIGN_PATH,{method:'POST',headers:{'content-type':'application/json',authorization:`${keyId}.${secret}`},body,signal});
      }catch(error){lastError=error?.name==='AbortError'?'aborted':'handshake-unreachable';continue;}
      if(!response.ok){lastError=response.status===401||response.status===403?'handshake-rejected':'handshake-failed';await response.body?.cancel?.().catch?.(()=>{});continue;}
      let payload;try{payload=await response.json();}catch{lastError='handshake-response-invalid';continue;}
      if(payload?.code!==200||!payload?.data?.privateCipher){lastError='handshake-rejected';continue;}
      const der=decryptPrivateCipher({keyId,secret,cipherB64:payload.data.privateCipher});
      try{privateKey=createPrivateKey({key:der,format:'der',type:'pkcs8'});}catch{lastError='private-key-invalid';continue;}
      handshakeOrigin=origin;
      const declared=Number(payload?.data?.powBits);
      powBits=Number.isInteger(declared)&&declared>0&&declared<=32?declared:SIGN_DEFAULT_POW_BITS;
      return {origin,powBits};
    }
    throw new ZCodeSignError(lastError);
  };

  const signingHeaders=async({sessionId,clientVersion:version=clientVersion,signal}={})=>{
    if(!sessionId)throw new ZCodeSignError('session-required');
    if(!privateKey)await handshake({signal});
    const ts=String(Date.now());
    const nonce=randomBytes(SIGN_NONCE_BYTES).toString('hex');
    const payload=canonicalString({keyId,ts,clientVersion:version,sessionId,nonce});
    let signature;
    try{signature=edSign(null,Buffer.from(payload,'utf8'),privateKey).toString('base64');}
    catch{privateKey=null;throw new ZCodeSignError('sign-failed');}
    const pow=solvePow({keyId,appId,sessionId,ts,bits:powBits});
    if(!pow)throw new ZCodeSignError('pow-failed');
    return {
      'X-Client-Ts':ts,'X-Client-Version':version,'X-Client-Sig':signature,
      'X-Session-Id':sessionId,'X-Client-Nonce':nonce,'X-App-Id':appId,'X-Client-Pow':pow,
    };
  };
  return {
    keyId,
    get origin(){return handshakeOrigin;},
    get powBits(){return powBits;},
    ensureKey:({signal}={})=>handshake({signal}),
    signingHeaders,
    invalidate(){privateKey=null;},
    verifySignature({headers,sessionId,clientVersion:version=clientVersion}){
      if(!privateKey)return false;
      const payload=canonicalString({keyId,ts:headers['X-Client-Ts'],clientVersion:version,sessionId,nonce:headers['X-Client-Nonce']});
      const publicKey=createPrivateKey({key:privateKey.export({format:'der',type:'pkcs8'}),format:'der',type:'pkcs8'});
      return edVerify(null,Buffer.from(payload,'utf8'),publicKey,Buffer.from(headers['X-Client-Sig'],'base64'));
    },
  };
}
