import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { operatorPresetPayload, serializeOperatorPreset, parseOperatorPreset, prepareOperatorPreset, OPERATOR_PRESET_KIND, OPERATOR_PRESET_MAX_BYTES } from '../../public/js/ui/operatorPresetModel.js';
import { applyOperatorPreset } from '../../public/js/ui/loadoutSync.js';
import { serializeExport } from '../../public/js/ui/loadoutModel.js';
import { serializeSkins } from '../../public/js/ui/skinsModel.js';
import { serializeOwnership } from '../../public/js/ui/ownershipModel.js';
import { serializeDiy, defaultPick } from '../../public/js/ui/diyModel.js';
import { OPERATOR_SKINS } from '../../shared/skins.js';
import { createStore } from '../../public/js/store.js';

const read = p => JSON.parse(readFileSync(new URL('../../data/'+p+'.json', import.meta.url)));
const chess = read('chess'), backups = read('backups');
const lookup = id => Object.hasOwn(chess,id) ? chess[id] : null;
const kitted = Object.keys(backups.diy.operators);
const deps = {lookup,data:{chess,backups},kitted};
const skin = OPERATOR_SKINS[0], slot = Object.keys(backups.diy.slots)[0];
const settings = () => ({ entries:{chess_char_1_01_a:{skill:0}}, notOwned:[],
  diy:{[slot]:defaultPick(kitted[0],slot,deps.data)}, skins:{[skin.charId]:skin.id} });

test('one portable preset round-trips gameplay, support and appearance without shared references', () => {
  const state=settings(), copy=structuredClone(state), raw=operatorPresetPayload(state,{now:0});
  assert.equal(raw.kind,OPERATOR_PRESET_KIND); assert.equal(raw.v,1); assert.equal(raw.exportedAt,'1970-01-01T00:00:00.000Z');
  assert.deepEqual(parseOperatorPreset(serializeOperatorPreset(state)).patch,state);
  assert.notEqual(raw.entries,state.entries); assert.notEqual(raw.entries.chess_char_1_01_a,state.entries.chess_char_1_01_a);
  const result=prepareOperatorPreset(parseOperatorPreset(raw),deps);
  assert.equal(result.ok,true); assert.equal(result.counts.diy,1); assert.equal(result.counts.skins,1);
  assert.deepEqual(state,copy);
});

test('a complete import validates all sections before one coherent store update and persistence', () => {
  const target=createStore({entries:{old:{skill:1}},notOwned:['old'],diy:{},skins:{},open:true});
  const updates=[],saved=[];target.subscribe(s=>updates.push(structuredClone(s)));
  const result=applyOperatorPreset(parseOperatorPreset(serializeOperatorPreset(settings())),deps,{target,persist:(key,value)=>saved.push({key,value})});
  assert.equal(result.ok,true);assert.equal(updates.length,1);assert.equal(saved.length,4);
  assert.deepEqual(saved.map(x=>x.key),['loadout','ownership','diy','skins']);
  assert.deepEqual(target.get().entries,settings().entries);assert.deepEqual(target.get().skins,settings().skins);
  assert.equal(target.get().open,true);
});

for(const section of ['entries','notOwned','diy','skins']) test('an unavailable '+section+' section aborts the entire preset without persistence or mutation',()=>{
  const before=settings(), target=createStore(structuredClone(before));const saved=[];
  const raw=operatorPresetPayload(settings());
  raw[section]=section==='notOwned'?['missing']:section==='entries'?{missing:{skill:0}}:section==='diy'?{missing:{charId:'missing'}}:{missing:'missing'};
  const r=applyOperatorPreset(parseOperatorPreset(raw),deps,{target,persist:(...x)=>saved.push(x)});
  assert.equal(r.ok,false);assert.deepEqual(target.get(),before);assert.deepEqual(saved,[]);
});

test('an explicit empty complete preset restores all defaults, while empty old loadout is still rejected',()=>{
  const empty={entries:{},notOwned:[],diy:{},skins:{}}, target=createStore(settings());
  assert.equal(applyOperatorPreset(parseOperatorPreset(serializeOperatorPreset(empty)),deps,{target,persist(){}}).ok,true);
  assert.deepEqual(target.get(),empty);
  assert.equal(parseOperatorPreset(serializeExport({})).ok,false);
});

for(const [name,encode,key] of [['loadout',s=>serializeExport(s.entries),'entries'],['ownership',s=>serializeOwnership(s.notOwned),'notOwned'],
  ['diy',s=>serializeDiy(s.diy),'diy'],['skins',s=>serializeSkins(s.skins),'skins']]) test('legacy '+name+' imports update only their original section',()=>{
  const target=createStore(settings()),before=structuredClone(target.get());const saved=[];
  const parsed=parseOperatorPreset(encode(settings()));assert.equal(parsed.ok,true);
  const result=applyOperatorPreset(parsed,deps,{target,persist:(k,v)=>saved.push([k,v])});assert.equal(result.ok,true);assert.equal(saved.length,1);
  for(const other of ['entries','notOwned','diy','skins'].filter(x=>x!==key))assert.deepEqual(target.get()[other],before[other]);
});

test('file scope parsing is pure and does not sanitise or change the supplied preset',()=>{
  const before=settings(), raw=operatorPresetPayload(before), input=structuredClone(raw);
  const parsed=parseOperatorPreset(raw);
  assert.equal(parsed.ok,true);assert.equal(parsed.scope,'all');
  assert.deepEqual(raw,input);assert.deepEqual(before,settings());
  assert.deepEqual(parseOperatorPreset(serializeSkins(before.skins)).scope,'skins');
});

for(const [name,missing] of [['lookup',{}],['null lookup',{...deps,lookup:null}],
  ['chess',{...deps,data:{backups}}],['backups',{...deps,data:{chess}}]]) test('missing '+name+' data rejects the complete preset before any persistence or store notification',()=>{
  const before=settings(),target=createStore(structuredClone(before));const saved=[],updates=[];
  target.subscribe(s=>updates.push(structuredClone(s)));
  const result=applyOperatorPreset(parseOperatorPreset(serializeOperatorPreset(before)),missing,{target,persist:(...args)=>saved.push(args)});
  assert.equal(result.ok,false);assert.deepEqual(saved,[]);assert.deepEqual(updates,[]);assert.deepEqual(target.get(),before);
});

test('legacy skins can be imported without game data and leave all gameplay sections intact',()=>{
  const before=settings(),target=createStore(structuredClone(before));const saved=[],updates=[];
  target.subscribe(s=>updates.push(structuredClone(s)));
  const result=applyOperatorPreset(parseOperatorPreset(serializeSkins({})),{}, {target,persist:(...args)=>saved.push(args)});
  assert.equal(result.ok,true);assert.equal(result.scope,'skins');assert.deepEqual(target.get(),{...before,skins:{}});
  assert.equal(updates.length,1);assert.equal(saved.length,1);assert.equal(saved[0][0],'skins');
});

test('missing DIY kit data cannot silently clear support or another valid section',()=>{
  const target=createStore(settings());const before=structuredClone(target.get());
  const result=applyOperatorPreset(parseOperatorPreset(serializeOperatorPreset(settings())),{...deps,kitted:null},{target,persist(){throw Error('must not persist')}});
  assert.equal(result.ok,false);assert.deepEqual(target.get(),before);
});

test('hostile, missing, oversized and newer envelopes are rejected without prototype changes',()=>{
  for(const x of ['{','',null,true,42,{kind:OPERATOR_PRESET_KIND,v:2}, {kind:OPERATOR_PRESET_KIND,v:1,entries:{}},
    {...operatorPresetPayload(settings()),skins:[]},'中'.repeat(Math.floor(OPERATOR_PRESET_MAX_BYTES/3)+1)])assert.equal(parseOperatorPreset(x).ok,false);
  const raw=JSON.parse(serializeOperatorPreset(settings()));raw.entries=JSON.parse('{"__proto__":{"skill":0},"constructor":{"skill":0},"chess_char_1_01_a":{"skill":0}}');
  const result=prepareOperatorPreset(parseOperatorPreset(raw),deps);assert.equal(result.ok,true);
  assert.deepEqual(Object.keys(result.patch.entries),['chess_char_1_01_a']);assert.equal({}.skill,undefined);
});

test('blocked browser storage still leaves one coherent in-memory preset',()=>{
  const target=createStore({entries:{},notOwned:[],diy:{},skins:{}});
  const result=applyOperatorPreset(parseOperatorPreset(serializeOperatorPreset(settings())),deps,{target,persist(){throw Error('blocked')}});
  assert.equal(result.ok,true);assert.deepEqual(target.get().skins,settings().skins);assert.deepEqual(target.get().entries,settings().entries);
});
