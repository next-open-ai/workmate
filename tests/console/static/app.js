const $ = (selector) => document.querySelector(selector)
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const statuses = {running:'运行中', stopping:'停止中', passed:'通过', failed:'失败', previewed:'已预览', stopped:'已停止', interrupted:'异常中断'}
let config, runs = [], selected = null, kind = 'regression', busy = false
const badge = (status) => `<span class="badge ${Object.hasOwn(statuses, status) ? status : 'interrupted'}">${esc(statuses[status] || status)}</span>`
const date = (value) => value ? new Date(value).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) : '—'
const duration = (run) => { const seconds = Math.max(0, Math.round(((run.finishedAt ? new Date(run.finishedAt) : Date.now()) - new Date(run.startedAt)) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds/60)}m ${seconds%60}s` }
const numeric = (value, digits=1) => value == null ? '—' : Number(value).toLocaleString('zh-CN', {maximumFractionDigits:digits})
function toast(message) { $('#toast').textContent=message; $('#toast').classList.remove('hidden'); setTimeout(()=>$('#toast').classList.add('hidden'), 3500) }
async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json','X-Console-Token':config.token},body:JSON.stringify(data)})
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || '请求失败')
  return body
}
function view(name) {
  for (const section of ['overview','history','guide']) $(`#${section}-view`).classList.toggle('hidden',name!==section)
  document.querySelectorAll('.nav-item[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===name))
}
function table(items) {
  if (!items.length) return '<div class="empty"><strong>这里还没有执行记录</strong>创建一个测试，开始记录本次迭代的质量。</div>'
  return `<table><thead><tr><th>测试名称 / 执行 ID</th><th>类型</th><th>状态</th><th>开始时间</th><th>耗时</th><th></th></tr></thead><tbody>${items.map(run=>`<tr><td><span class="run-title">${esc(run.title)}</span><span class="run-sub">${esc(run.id.slice(0,12))}${run.imported ? ' · 历史导入' : ''}</span></td><td>${run.kind==='regression' ? '回归' : '压测'}</td><td>${badge(run.status)}</td><td>${date(run.startedAt)}</td><td>${run.imported ? '—' : duration(run)}</td><td><button class="text-button" data-detail="${esc(run.id)}">查看详情 →</button></td></tr>`).join('')}</tbody></table>`
}
function render() {
  const executed = runs.filter(r=>!r.imported && ['passed','failed'].includes(r.status))
  const passed = executed.filter(r=>r.status==='passed').length
  const active = runs.filter(r=>['running','stopping'].includes(r.status)).length
  const cards = [ ['累计执行',runs.filter(r=>!r.imported&&r.status!=='previewed'&&!(r.kind==='load'&&!r.config.live)).length,'不含历史导入和计划预览','◷'], ['执行通过率',executed.length?`${Math.round(passed/executed.length*100)}%`:'—',`${passed} 通过 / ${executed.length} 次已判定执行`,'✓'], ['执行中',active,active?'等待完成后可启动下一项':'当前没有运行中的测试','↗'], ['未通过执行',executed.length-passed,'按执行统计 · 不等于失败断言数','◫'] ]
  $('#stats').innerHTML=cards.map(([label,value,note,symbol])=>`<article class="stat"><span class="label">${label}</span><span class="stat-symbol">${symbol}</span><div class="value">${value}</div><small>${note}</small></article>`).join('')
  $('#recent-table').innerHTML=table(runs.slice(0,6))
  const query = $('#search').value.toLowerCase(), type = $('#kind-filter').value, status = $('#status-filter').value
  $('#history-table').innerHTML=table(runs.filter(r=>(!type||r.kind===type)&&(!status||r.status===status)&&`${r.title} ${r.id}`.toLowerCase().includes(query)))
}
function setKind(value) {
  kind=value
  $('#regression-fields').classList.toggle('hidden',kind!=='regression')
  $('#load-fields').classList.toggle('hidden',kind!=='load')
  $('#regression-tab').classList.toggle('selected',kind==='regression')
  $('#load-tab').classList.toggle('selected',kind==='load')
  // Hidden inputs must not block browser validation of the other form.
  $('#regression-fields').querySelectorAll('input,select').forEach(el=>el.disabled=kind!=='regression')
  $('#load-fields').querySelectorAll('input,select').forEach(el=>el.disabled=kind!=='load')
  $('#form-error').classList.add('hidden')
  updateForm()
}
function updateForm() {
  const form=$('#create-form')
  $('#mysql-field').classList.toggle('hidden',form.elements.group.value!=='experience-control')
  $('#run-fields').classList.toggle('hidden',form.elements.scenario.value!=='run')
  $('#submit-test').textContent=kind==='regression'?'开始回归':form.elements.live.checked?'开始实测':'预览计划'
  $('#create-hint').textContent=runs.some(r=>['running','stopping'].includes(r.status))?'已有测试运行，请等待或先停止':'一次仅执行一个测试'
}
function newTest(type) {setKind(type); $('#create-dialog').showModal()}
function chart(stages) {
  const values=stages.map(s=>s.summary?.p95Ms)
  if (!values.some(v=>v!=null)) return ''
  const max=Math.max(1,...values.filter(v=>v!=null)), x=(i)=>55+i*590/Math.max(1,stages.length-1), y=(v)=>90-v/max*60
  return `<div class="chart-title">各并发阶段 P95 · 毫秒（同一次执行内比较）</div><svg class="chart" viewBox="0 0 700 125" role="img" aria-label="各并发阶段 P95 耗时"><line x1="40" y1="95" x2="665" y2="95"/><polyline points="${values.map((v,i)=>`${x(i)},${y(v||0)}`).join(' ')}"/>${values.map((v,i)=>`<circle cx="${x(i)}" cy="${y(v||0)}" r="3"/><text x="${x(i)}" y="${y(v||0)-10}" text-anchor="middle">${numeric(v)}</text><text x="${x(i)}" y="115" text-anchor="middle">${esc(stages[i].concurrency)} 并发</text>`).join('')}</svg>`
}
function reportHTML(run) {
  const report=run.report
  if(!report) return `<div class="detail-summary">${run.status==='previewed'?'计划已生成，见下方日志。未发送真实请求，不计入通过率。':run.status==='running'?'测试已启动。回归按套件、压测按阶段更新报告。':'尚无结构化报告，请查看日志定位原因。'}</div>`
  if(report.suites) return `<div class="result-table"><table><thead><tr><th>回归套件</th><th>结果</th><th>耗时</th><th>退出码 / 原因</th></tr></thead><tbody>${report.suites.map(s=>`<tr><td>${esc(s.name)}</td><td>${badge(s.passed?'passed':'failed')}</td><td>${numeric(s.durationSeconds)}s</td><td>${esc(s.error??s.exitCode??'—')}</td></tr>`).join('')}</tbody></table></div><div class="detail-summary">已完成 ${report.suites.length} 个套件。各套件内部用例数量与失败原因见日志；整体以执行终态为准。</div>`
  if(report.stages) return `${chart(report.stages)}<div class="result-table"><table><thead><tr><th>并发</th><th>样本</th><th>失败</th><th>错误率</th><th>P50</th><th>P95</th><th>P99</th><th>吞吐 / 秒</th></tr></thead><tbody>${report.stages.map(s=>{const a=s.summary;return `<tr><td>${esc(s.concurrency)}</td><td>${numeric(a.samples,0)}</td><td>${numeric(a.failed,0)}</td><td>${a.errorRate==null?'—':numeric(a.errorRate*100,2)+'%'}</td><td>${numeric(a.p50Ms)} ms</td><td>${numeric(a.p95Ms)} ms</td><td>${numeric(a.p99Ms)} ms</td><td>${numeric(a.throughputPerSecond,2)}</td></tr>`}).join('')}</tbody></table></div><div class="detail-summary">完成 ${report.stages.length} 个阶段 · 停止原因：${esc(report.stopReason||'执行中')}。报告中的首文本耗时来自轮询，不等于 SSE 首 Token 时间。</div>`
  return '<div class="detail-summary">此历史报告请下载 JSON 查看。</div>'
}
async function refreshDetail() {
  if(!selected||!$('#detail-dialog').open)return
  const id=selected, run=await api(`/api/runs/${id}`)
  if(selected!==id)return
  $('#detail-title').textContent=run.title
  $('#detail-meta').innerHTML=`<div class="detail-meta">${badge(run.status)}<span>${date(run.startedAt)}</span><span>${run.imported?'历史导入':duration(run)}</span><code>${esc(run.id.slice(0,12))}</code></div>${run.error?`<div class="error">${esc(run.error)}</div>`:''}`
  $('#detail-report').innerHTML=reportHTML(run)
  if(run.target){const target=document.createElement('div');target.className='detail-summary';target.textContent=`测试目标：${run.target} · 并发 ${run.config.concurrency} · 每阶段 ${run.config.duration}s · P95 门槛 ${run.config.p95}ms`;$('#detail-report').prepend(target)}
  const log=$('#detail-log'), atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<35
  if(log.textContent!==run.log){log.textContent=run.log|| (run.imported?'历史导入提供结构化报告。原始日志位于 CLI 报告目录。':'等待测试输出…');if(atBottom)log.scrollTop=log.scrollHeight}
  $('#stop-test').classList.toggle('hidden',!['running','stopping'].includes(run.status))
  $('#stop-test').disabled=run.status==='stopping'
  $('#stop-test').textContent=run.status==='stopping'?'正在收尾…':'停止执行'
  $('#download-report').classList.toggle('hidden',!run.report)
  $('#download-report').href=`/api/runs/${id}/report`
  $('#detail-note').textContent=run.status==='stopping'?'停止新增请求，等待在途操作收尾':run.imported?'历史报告不计入总览通过率':'报告保存在本机'
}
async function refresh() {
  if(busy)return
  busy=true
  try {runs=await api('/api/runs');render();await refreshDetail();$('#connection').textContent='● 本机服务已连接'}
  catch(error){$('#connection').textContent='○ 连接中断，正在重试'}
  finally{busy=false}
}
document.addEventListener('click',async(event)=>{
  const button=event.target.closest('[data-view],[data-new],[data-detail]')
  if(!button)return
  if(button.dataset.view)view(button.dataset.view)
  if(button.dataset.new)newTest(button.dataset.new)
  if(button.dataset.detail){selected=button.dataset.detail;$('#detail-title').textContent='加载详情…';$('#detail-report').textContent='';$('#detail-log').textContent='';$('#detail-dialog').showModal();try{await refreshDetail()}catch(error){toast(error.message)}}
})
$('#regression-tab').onclick=()=>setKind('regression')
$('#load-tab').onclick=()=>setKind('load')
document.querySelectorAll('.close-create').forEach(el=>el.onclick=()=>$('#create-dialog').close())
$('#close-detail').onclick=()=>$('#detail-dialog').close()
$('#create-form').onchange=updateForm
$('#create-form').onsubmit=async(event)=>{
  event.preventDefault()
  const fields=$('#create-form').elements
  const data=kind==='regression'?{kind,group:fields.group.value,mysql:fields.group.value==='experience-control'&&fields.mysql.checked}:{kind,scenario:fields.scenario.value,concurrency:fields.concurrency.value,duration:Number(fields.duration.value),maxRequests:Number(fields.maxRequests.value),p95:Number(fields.p95.value),errorRate:Number(fields.errorRate.value)/100,runTimeout:Number(fields.runTimeout.value),agentId:fields.agentId.value,live:fields.live.checked,allowWrites:fields.allowWrites.checked}
  $('#submit-test').disabled=true
  try {const run=await api('/api/runs',data);$('#create-dialog').close();selected=run.id;$('#detail-dialog').showModal();await refresh();toast('测试已创建')}
  catch(error){$('#form-error').textContent=error.message;$('#form-error').classList.remove('hidden')}
  finally{$('#submit-test').disabled=false}
}
$('#stop-test').onclick=async()=>{try{await api(`/api/runs/${selected}/stop`,{});await refreshDetail()}catch(error){toast(error.message)}}
$('#copy-log').onclick=async()=>{try{await navigator.clipboard.writeText($('#detail-log').textContent);toast('日志已复制')}catch{toast('复制失败，请手动选择日志')}}
for(const selector of ['#search','#kind-filter','#status-filter'])$(selector).addEventListener('input',render)
async function init(){try{config=await api('/api/config');document.querySelectorAll('.benchmark-link').forEach(el=>el.href=config.benchmark);$('#target-url').textContent=config.target;$('#credentials-state').textContent=config.credentialsReady?'● 测试账号已配置':'○ 未配置测试账号；可预览计划';await refresh();setInterval(refresh,1500)}catch(error){$('#connection').textContent='○ 服务未连接';toast(error.message)}}
init()
