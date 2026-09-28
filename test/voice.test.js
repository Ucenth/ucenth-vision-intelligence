import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createServer } from "../server.js";
import { VOICE, FOLLOW_UP_INSTRUCTION } from "../lib/conversation.js";
const picture=await sharp({create:{width:80,height:80,channels:3,background:"#718cab"}}).jpeg().toBuffer();
const payload={image:`data:image/jpeg;base64,${picture.toString("base64")}`,identification:{name:"Example lotion",confidence:"medium",needsAnotherView:true},question:"What is it used for?",history:[]};
async function serve(services,run){const server=createServer({identify:async()=>({name:"test"}),...services});await new Promise(r=>server.listen(0,"127.0.0.1",r));try{await run(`http://127.0.0.1:${server.address().port}`);}finally{await new Promise(r=>server.close(r));}}
const post=(url,path,data,headers={})=>fetch(url+path,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(data)});
test("follow-up preserves original bytes and cautious context; rejects oversized history and cross-site requests",async()=>{
let calls=0;await serve({followUp:async input=>{calls++;assert.deepEqual(input.image,picture);assert.equal(input.identification.needsAnotherView,true);assert.equal(input.question,payload.question);return "It is a body lotion.";}},async base=>{
assert.equal((await post(base,"/api/follow-up",payload)).status,200);
assert.equal((await post(base,"/api/follow-up",{...payload,history:Array(7).fill({role:"user",text:"x"})})).status,400);
assert.equal((await post(base,"/api/follow-up",{...payload,image:"data:image/jpeg;base64,YWJjZA=="})).status,400);
assert.equal((await post(base,"/api/follow-up",payload,{Origin:"https://example.com"})).status,403);
assert.equal((await post(base,"/api/follow-up",{...payload,question:"x".repeat(701)})).status,400);
assert.equal(calls,1);
});});
test("speech route is bounded and returns audio only, with safe provider failures",async()=>{
assert.equal(VOICE,"en-US-Chirp3-HD-Charon");assert.match(FOLLOW_UP_INSTRUCTION,/scanned subject/);
await serve({synthesize:async text=>{if(text==="fail")throw Object.assign(Error("sensitive-provider-detail"),{status:403});return Buffer.from("RIFF-test-audio");}},async base=>{
const good=await post(base,"/api/speech",{text:"Hello"});assert.equal(good.status,200);assert.equal(good.headers.get("content-type"),"audio/wav");assert.equal(await good.text(),"RIFF-test-audio");
assert.equal((await post(base,"/api/speech",{text:"x".repeat(1801)})).status,400);
const failed=await post(base,"/api/speech",{text:"fail"});assert.equal(failed.status,503);assert.doesNotMatch(await failed.text(),/sensitive-provider-detail/);
assert.equal((await fetch(base+"/lib/conversation.js")).status,404);
});});
test("follow-up upstream errors do not expose provider details",async()=>{await serve({followUp:async()=>{throw Error("sensitive-provider-detail");}},async base=>{const result=await post(base,"/api/follow-up",payload);assert.equal(result.status,502);assert.doesNotMatch(await result.text(),/sensitive-provider-detail/);});});
test("transcribe route accepts a short clip, bounds size and type, and never exposes provider details",async()=>{
await serve({transcribe:async(audio,mime)=>{assert.equal(mime,"audio/webm");assert.equal(audio.length,4000);return "what is the total";}},async base=>{
const clip=Buffer.alloc(4000,1);
const ok=await fetch(base+"/api/transcribe",{method:"POST",headers:{"Content-Type":"audio/webm;codecs=opus"},body:clip});assert.equal(ok.status,200);assert.equal((await ok.json()).text,"what is the total");
assert.equal((await fetch(base+"/api/transcribe",{method:"POST",headers:{"Content-Type":"text/plain"},body:clip})).status,415);
assert.equal((await fetch(base+"/api/transcribe",{method:"POST",headers:{"Content-Type":"audio/mp4"},body:Buffer.alloc(100)})).status,400);
assert.equal((await fetch(base+"/api/transcribe",{method:"POST",headers:{"Content-Type":"audio/webm"},body:Buffer.alloc(1.6*1024*1024)})).status,413);
});
await serve({transcribe:async()=>{throw Error("sensitive-provider-detail");}},async base=>{const r=await fetch(base+"/api/transcribe",{method:"POST",headers:{"Content-Type":"audio/webm"},body:Buffer.alloc(4000,1)});assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/sensitive-provider-detail/);});
});
