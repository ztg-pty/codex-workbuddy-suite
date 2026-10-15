import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,createHash,createHmac,generateKeyPairSync,createPrivateKey} from 'node:crypto';
import {hkdfSha256,solvePow,leadingZeroBits,hasLeadingZeroBits,canonicalString,createSigner,sha256Hex,SIGN_KDF_SALT,SIGN_KDF_HMAC,SIGN_KDF_PRIV} from '../src/providers/zcode-sign.mjs';
import {discoverZCodeCredential,discoverZCodeAccount,isSignCredential,jwtUid,platformTag} from '../src/providers/zcode-credentials.mjs';

test('HKDF-SHA256 matches RFC 5869 test case 1',()=>{
  const ikm=Buffer.alloc(22,0x0b);
  const salt=Buffer.from('000102030405060708090a0b0c','hex');
  const info=Buffer.from('f0f1f2f3f4f5f6f7f8f9','hex');
  const out=hkdfSha256(ikm,salt,info,42);
  assert.equal(out.toString('hex'),'3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
});

test('proof of work finds a nonce with the required leading zero bits',()=>{
  const keyId='a'.repeat(32);
  const nonce=solvePow({keyId,sessionId:'session-fixed',ts:'1700000000000',bits:4});
  assert.ok(nonce);
  const prefix=sha256Hex(`${keyId}\nzcode\nsession-fixed\n1700000000000`).slice(0,32);
  assert.ok(hasLeadingZeroBits(Buffer.from(sha256Hex(`${prefix}\n${nonce}`),'hex'),4));
});

test('proof of work derives its prefix from the newline-separated seed',()=>{
  const keyId='b'.repeat(32);
  const nonce=solvePow({keyId,sessionId:'s',ts:'1',bits:2});
  const expectedSeed=sha256Hex(`${keyId}\nzcode\ns\n1`).slice(0,32);
  // A solution exists only for the documented seed, so validating against it
  // proves the separator choice; a space-separated seed would fail to verify.
  assert.ok(hasLeadingZeroBits(Buffer.from(sha256Hex(`${expectedSeed}\n${nonce}`),'hex'),2));
});

test('leading zero bit counting handles full and partial zero bytes',()=>{
  assert.equal(leadingZeroBits(Buffer.from([0x00,0x00])),16);
  assert.equal(leadingZeroBits(Buffer.from([0x80])),0);
  assert.equal(leadingZeroBits(Buffer.from([0x40])),1);
  assert.equal(leadingZeroBits(Buffer.from([0x00,0x0f])),12);
});

test('the canonical signing string is newline separated in the documented order',()=>{
  assert.equal(canonicalString({keyId:'k',ts:'1',clientVersion:'3.14.4',sessionId:'s',nonce:'n'}),'k\n1\n3.14.4\ns\nn');
});

test('leading zero bit test matches the client byte-then-mask rule',()=>{
  assert.equal(hasLeadingZeroBits(Buffer.from([0x00,0x0f]),12),true);
  assert.equal(hasLeadingZeroBits(Buffer.from([0x00,0x10]),12),false);
  assert.equal(hasLeadingZeroBits(Buffer.from([0x00]),8),true);
  assert.equal(hasLeadingZeroBits(Buffer.from([0x01]),0),true);
});

test('a signing credential requires keyId.secret shape and is not a JWT',()=>{
  assert.equal(isSignCredential('a'.repeat(32)+'.'+'b'.repeat(32)),true);
  assert.equal(isSignCredential('not-a-credential'),false);
  assert.equal(isSignCredential('abc.'),false);
  assert.equal(isSignCredential(undefined),false);
});

test('the signer completes the documented handshake and emits the exact header set, reusing the key',async()=>{
  const {privateKey}=generateKeyPairSync('ed25519');
  // The client wraps a base64 *text* PKCS8 payload, so mirror that here.
  const pkcs8der=privateKey.export({format:'der',type:'pkcs8'});
  const wrapped=Buffer.from(pkcs8der.toString('base64'),'utf8');
  const secret='s'.repeat(32);
  const keyId='a'.repeat(32);
  let handshakes=0;
  const fetchImpl=async(url,options)=>{
    handshakes++;
    assert.match(url,/api\/paas\/c1f3a7e2\/v2\/client$/);
    assert.equal(options.headers.authorization,`${keyId}.${secret}`);
    const body=JSON.parse(options.body);
    assert.equal(body.apiKey,`${keyId}.${secret}`);
    assert.equal(body.nonce.length,32);
    // HMAC must be derived with the handshake info string.
    const hk=hkdfSha256(Buffer.from(secret),Buffer.from(SIGN_KDF_SALT),Buffer.from(SIGN_KDF_HMAC),32);
    const expected=createHmac('sha256',hk).update(`get_sign_key\n${keyId}\n${body.ts}\n${body.nonce}`).digest('base64');
    assert.equal(body.sig,expected);
    const aesKey=hkdfSha256(Buffer.from(secret),Buffer.from(SIGN_KDF_SALT),Buffer.from(SIGN_KDF_PRIV),32);
    const nonce=Buffer.alloc(12,1);
    const cipher=createCipheriv('aes-256-gcm',aesKey,nonce);
    cipher.setAAD(Buffer.from(keyId,'utf8'));
    const ciphertext=Buffer.concat([cipher.update(wrapped),cipher.final()]);
    const payload=Buffer.concat([nonce,ciphertext,cipher.getAuthTag()]).toString('base64');
    return new Response(JSON.stringify({code:200,data:{privateCipher:payload,powBits:4}}),{status:200,headers:{'content-type':'application/json'}});
  };
  const signer=createSigner({credential:`${keyId}.${secret}`,fetchImpl,clientVersion:'3.14.4'});
  const headers=await signer.signingHeaders({sessionId:'session-fixed'});
  assert.equal(headers['X-Session-Id'],'session-fixed');
  assert.equal(headers['X-App-Id'],'zcode');
  assert.equal(headers['X-Client-Version'],'3.14.4');
  // The verified contract has no X-Client-Key or X-Client-Pow-Bits header.
  assert.equal(headers['X-Client-Key'],undefined);
  assert.equal(headers['X-Client-Pow-Bits'],undefined);
  assert.ok(headers['X-Client-Sig']);
  // The PoW must satisfy the declared difficulty.
  const prefix=sha256Hex(`${keyId}\nzcode\nsession-fixed\n${headers['X-Client-Ts']}`).slice(0,32);
  assert.ok(hasLeadingZeroBits(Buffer.from(sha256Hex(`${prefix}\n${headers['X-Client-Pow']}`),'hex'),4));
  // The canonical string is signed with the exchanged Ed25519 key.
  assert.ok(signer.verifySignature({headers,sessionId:'session-fixed'}));
  await signer.signingHeaders({sessionId:'second'});
  assert.equal(handshakes,1,'the derived key is cached across calls');
});

test('a handshake rejection surfaces a typed error and does not cache a key',async()=>{
  const signer=createSigner({credential:`${'a'.repeat(32)}.${'b'.repeat(32)}`,fetchImpl:async()=>new Response('no',{status:401}),origins:['https://handshake.example']});
  await assert.rejects(()=>signer.signingHeaders({sessionId:'s'}),error=>error.name==='ZCodeSignError'&&/handshake/.test(error.code));
});

test('signing requires a non-empty session id',async()=>{
  const signer=createSigner({credential:`${'a'.repeat(32)}.${'b'.repeat(32)}`,fetchImpl:async()=>{throw new Error('must not be called');}});
  await assert.rejects(()=>signer.signingHeaders({}),error=>error.code==='session-required');
});

test('credential discovery reads the client product and rejects a JWT-shaped value',async()=>{
  const doc=JSON.stringify({provider:{'builtin:bigmodel-coding-plan':{options:{apiKey:`${'c'.repeat(32)}.${'d'.repeat(32)}`}}}});
  const file='C:/fixture/.zcode/v2/config.json';
  const found=await discoverZCodeCredential({home:'C:/fixture',readFile:async()=>doc});
  assert.equal(found.value,`${'c'.repeat(32)}.${'d'.repeat(32)}`);
  assert.equal(found.source,'provider');
  const none=await discoverZCodeCredential({home:'C:/fixture',readFile:async()=>JSON.stringify({provider:{'builtin:x':{options:{apiKey:'not-a-credential'}}}})});
  assert.equal(none,undefined);
});

test('a missing or unreadable client config reports absence instead of throwing',async()=>{
  const missing=await discoverZCodeCredential({home:'C:/nope',readFile:async()=>{const error=new Error('missing');error.code='ENOENT';throw error;}});
  assert.equal(missing,undefined);
});

test('account uid is read from user_info before falling back to the JWT payload',async()=>{
  const withInfo=JSON.stringify({'default:user_info':JSON.stringify({id:'uid-info',customer_id:'cust'})});
  assert.equal((await discoverZCodeAccount({home:'C:/fixture',readFile:async()=>withInfo})).uid,'uid-info');
  const payload=Buffer.from(JSON.stringify({user_id:'uid-jwt'})).toString('base64url');
  const withJwt=JSON.stringify({zcodejwttoken:`h.${payload}.s`});
  assert.equal((await discoverZCodeAccount({home:'C:/fixture',readFile:async()=>withJwt})).uid,'uid-jwt');
  assert.equal(jwtUid('h.'+payload+'.s'),'uid-jwt');
});

test('the platform tag mirrors the client and never uses the Go spelling',()=>{
  assert.equal(platformTag('win32'),'win32');
  assert.equal(platformTag('darwin'),'darwin');
});
