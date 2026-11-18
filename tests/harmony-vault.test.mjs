import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../apps/harmony/entry/src/main/ets/services/SessionVault.ets',import.meta.url),'utf8').replace(/^import .*;$/gm,'');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
let saved,release;const gate=new Promise(r=>release=r),order=[];const Tag={ALIAS:1,SECRET:2,ACCESSIBILITY:3,AUTH_TYPE:4,SYNC_TYPE:5,CONFLICT_RESOLUTION:6,RETURN_TYPE:7};
const asset={Tag,Accessibility:{DEVICE_FIRST_UNLOCKED:1},AuthType:{NONE:0},SyncType:{NEVER:0},ConflictResolution:{OVERWRITE:0},ReturnType:{ALL:0},ErrorCode:{NOT_FOUND:24000002},
 async add(map){order.push('save-start');await gate;saved=map;order.push('save-done');},async remove(){order.push('clear');saved=undefined;},async query(){if(!saved)throw {code:24000002};return [saved];}};
const context={exports:{},Map,JSON,Error,Uint8Array,asset,util:{TextEncoder:class{encodeInto(x){return new TextEncoder().encode(x);}},TextDecoder:{create:()=>({decodeToString:x=>new TextDecoder().decode(x)})}}};vm.runInNewContext(compiled,context);const Vault=context.exports.SessionVault;const vault=new Vault();
assert.equal(await vault.load(),undefined);const save=vault.save({token:'secret',baseUrl:'https://fish.sdspeed.com.cn'});const clear=vault.clear();await Promise.resolve();assert.deepEqual(order,['save-start']);release();await Promise.all([save,clear]);assert.deepEqual(order,['save-start','save-done','clear']);assert.equal(await vault.load(),undefined);
await vault.save({token:'second-secret',baseUrl:'https://fish.sdspeed.com.cn'});assert.equal(saved.get(Tag.SYNC_TYPE),0);assert.equal(saved.get(Tag.ACCESSIBILITY),1);assert.equal(typeof saved.get(Tag.SECRET),'object');const result=await vault.load();assert.equal(result.token,'second-secret');assert.equal(result.baseUrl,'https://fish.sdspeed.com.cn');await vault.clear();assert.equal(await vault.load(),undefined);
const report={passed:true,checks:['missing credentials handled','logout deletion runs after pending save','token + origin stored together in SECRET','device scope NEVER sync + first-unlock accessibility','round trip and logout clear']};console.log(JSON.stringify(report,null,2));


