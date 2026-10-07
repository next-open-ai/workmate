// Render the production token page with synthetic microphone and provider events only.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
const req = createRequire(fs.realpathSync('apps/renderer/node_modules/vite/package.json'));
const { transform } = req('esbuild');
const uiSource = fs.readFileSync('apps/api/src/modules/chat-mobile/voice-ui.ts', 'utf8');
const ui = await import('data:text/javascript;base64,' + Buffer.from((await transform(uiSource, { loader: 'ts', format: 'esm' })).code).toString('base64'));
const routeSource = fs.readFileSync('apps/api/src/modules/chat-mobile/routes.ts', 'utf8');
const start = routeSource.indexOf('export function mobileChatHtml(');
const end = routeSource.indexOf('\nfunction expiredHtml()', start);
const pageSource = (await transform(routeSource.slice(start, end), { loader: 'ts', format: 'cjs' })).code;
const module = { exports: {} };
new Function('module', 'exports', ...Object.keys(ui), pageSource)(module, module.exports, ...Object.values(ui));
const mock = String.raw`
window.__mobileMock={closed:0,audio:0,tracksStopped:0};
const fixtureMode=new URLSearchParams(location.search).get('mode');
if(fixtureMode==='insecure')Object.defineProperty(window,'isSecureContext',{value:false});
setInterval(()=>{document.body.dataset.mockAudio=window.__mobileMock.audio;document.body.dataset.mockClosed=window.__mobileMock.closed;document.body.dataset.mockTracksStopped=window.__mobileMock.tracksStopped;},100);
class AudioMock {
 sampleRate=48000;state='running';currentTime=0;destination={};timers=[];
 async resume(){}async close(){this.state='closed';this.timers.forEach(clearInterval);}
 createMediaStreamSource(){return {connect(){},disconnect(){}}}
 createGain(){return {gain:{value:0},connect(){},disconnect(){}}}
 createScriptProcessor(){const node={connect(){},disconnect(){},onaudioprocess:null};this.timers.push(setInterval(()=>{this.currentTime+=.085;node.onaudioprocess?.({inputBuffer:{getChannelData:()=>Float32Array.from({length:4096},(_,i)=>Math.sin(i*.13)*.1)}})},85));return node;}
 createAnalyser(){return {fftSize:256,connect(){},disconnect(){},getByteTimeDomainData(data){for(let i=0;i<data.length;i++)data[i]=128+Math.sin(i*.2+Date.now()/100)*12;}}}
 createBuffer(ch,n,rate){return {duration:n/rate,getChannelData:()=>new Float32Array(n)}}
 createBufferSource(){return {connect(){},start(){},stop(){}}}
}
window.AudioContext=AudioMock;Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{if(fixtureMode==='denied'){const error=new Error('denied');error.name='NotAllowedError';throw error;}return {getTracks:()=>[{stop(){window.__mobileMock.tracksStopped++;}}]};}}});
window.EventSource=class {
 constructor(){this.timers=[setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'local.connected'})}),100),setTimeout(()=>{
  for(const event of [{type:'conversation.item.input_audio_transcription.started'},{type:'conversation.item.input_audio_transcription.completed',text:'帮我安排上海到桂林五天的旅行，交给数字员工开始工作。'},{type:'response.output_text.done',text:'已交给数字员工处理，行程和文件会出现在当前聊天里。'},{type:'response.done'}])this.onmessage?.({data:JSON.stringify({type:'upstream.event',event})});
  this.onmessage?.({data:JSON.stringify({type:'local.work_result',result:{ok:true,status:'running',spokenSummary:'数字员工正在整理行程。'}})});
 },650)];}close(){this.timers.forEach(clearTimeout);}
};
const realFetch=window.fetch;window.fetch=async(url,options={})=>{
 if(String(url).includes('/voice/')){let result={};if(String(url).endsWith('/capabilities'))result={enabled:true,workEnabled:true};if(String(url).endsWith('/session'))result={session_id:'synthetic',expiresAt:Date.now()+60000};if(String(url).endsWith('/audio'))window.__mobileMock.audio++;if(String(url).endsWith('/close'))window.__mobileMock.closed++;return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});}
 return realFetch(url,options);
};
`;
const production = module.exports.mobileChatHtml('synthetic-preview');
const html = production.replace('<script>', '<script>' + mock + '\n');
const server = createServer((request, response) => {
  if (request.url.includes('/state')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ title: '手机语音 · 交互验收', messages: [{ id: 'one', role: 'assistant', content: '你好，可以文字聊天，也可以点击电话开始实时对话。任务和成果会与电脑同步。' }], busy: false })); }
  else { response.setHeader('content-type', 'text/html'); response.end(html); }
});
server.listen(47844, '127.0.0.1', () => console.log('Synthetic mobile voice UI: http://127.0.0.1:47844'));
process.on('SIGINT', () => server.close(() => process.exit(0)));
