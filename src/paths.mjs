import path from 'node:path';
import {homedir} from 'node:os';
export const codexHome=path.resolve(process.env.CODEX_HOME??path.join(homedir(),'.codex'));
export const stateDir=path.resolve(process.env.WORKBUDDY_STATE_DIR??path.join(codexHome,'workbuddy-suite'));
