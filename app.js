const $ = (s) => document.querySelector(s);
const cfg = window.ORTIZ_CONFIG || {};
const directFilePreview = window.location.protocol === 'file:';
const cloudConfigured = Boolean(cfg.supabaseUrl && cfg.supabasePublishableKey);
let supabase = null;
let cloudReady = false;

const messagesEl = $('#messages'), emptyState = $('#emptyState'), input = $('#promptInput'), sendBtn = $('#sendBtn');
const chatList = $('#chatList'), fileInput = $('#fileInput'), fileChip = $('#fileChip'), modeLabel = $('#modeLabel');
let attachedFile = null, session = null, profile = null, authMode = 'signin';
let chats = JSON.parse(localStorage.getItem('ortiz-ai-chats') || '[]');
let currentChatId = localStorage.getItem('ortiz-ai-current') || null;

function toast(message) { const el=$('#toast'); el.textContent=message; el.classList.remove('hidden'); setTimeout(()=>el.classList.add('hidden'),2600); }
function openModal(id){ $('#'+id).classList.remove('hidden'); }
function closeModal(id){ $('#'+id).classList.add('hidden'); }
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>closeModal(b.dataset.close));
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{ if(e.target===m) closeModal(m.id); }));

function saveLocal() { localStorage.setItem('ortiz-ai-chats', JSON.stringify(chats)); if(currentChatId) localStorage.setItem('ortiz-ai-current', currentChatId); }
function getCurrentChat(){ return chats.find(c=>c.id===currentChatId); }

async function loadCloudChats(){
  if(!session || !supabase) return;
  const {data,error}=await supabase.from('conversations').select('id,title,created_at,updated_at,messages(id,role,content,attachment_name,created_at)').order('updated_at',{ascending:false});
  if(error){ console.error(error); toast('Could not load cloud chats.'); return; }
  chats=(data||[]).map(c=>({id:c.id,title:c.title,messages:(c.messages||[]).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at)).map(m=>({id:m.id,role:m.role,content:m.content,createdAt:m.created_at})),createdAt:c.created_at}));
  if(!getCurrentChat()) currentChatId=chats[0]?.id||null;
  saveLocal(); renderAll();
}

async function createChat(){
  if(session && supabase){
    const {data,error}=await supabase.from('conversations').insert({user_id:session.user.id,title:'New chat'}).select().single();
    if(error){ toast(error.message); return null; }
    chats.unshift({id:data.id,title:data.title,messages:[],createdAt:data.created_at}); currentChatId=data.id;
  } else {
    const id=crypto.randomUUID(); chats.unshift({id,title:'New chat',messages:[],createdAt:Date.now()}); currentChatId=id;
  }
  saveLocal(); renderAll(); return getCurrentChat();
}

async function ensureChat(){ return getCurrentChat() || await createChat(); }

function renderSidebar(){
  chatList.innerHTML='';
  chats.forEach(chat=>{ const b=document.createElement('button'); b.className='chat-item'+(chat.id===currentChatId?' active':''); b.textContent=chat.title||'New chat'; b.onclick=()=>{currentChatId=chat.id;saveLocal();renderAll();closeSidebar();}; chatList.appendChild(b); });
}
function renderMessages(){
  messagesEl.innerHTML=''; const chat=getCurrentChat(); const has=chat?.messages?.length;
  emptyState.classList.toggle('hidden',!!has); messagesEl.classList.toggle('hidden',!has); if(!has)return;
  chat.messages.forEach(m=>addMessageToDOM(m.role,m.content)); scrollBottom();
}
function addMessageToDOM(role,content,isTyping=false){
  const row=document.createElement('div'); row.className=`message ${role}`; const avatar=document.createElement('div'); avatar.className='avatar'; avatar.textContent=role==='user'?'YOU':'O'; const bubble=document.createElement('div'); bubble.className='bubble';
  if(isTyping) bubble.innerHTML='<span class="typing"><span></span><span></span><span></span></span>'; else bubble.textContent=content; row.append(avatar,bubble); messagesEl.appendChild(row); return row;
}
function renderAll(){ renderSidebar(); renderMessages(); updateAccountUI(); }
function scrollBottom(){ requestAnimationFrame(()=>{$('.chat-stage').scrollTop=999999;}); }
function autosize(){ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,160)+'px'; }

async function persistMessage(chat,role,content,attachmentName=null){
  if(!session || !supabase) return null;
  const {data,error}=await supabase.from('messages').insert({conversation_id:chat.id,user_id:session.user.id,role,content,attachment_name:attachmentName}).select().single();
  if(error) throw error; return data;
}

async function sendMessage(textOverride){
  const text=(textOverride??input.value).trim(); if(!text||sendBtn.disabled)return;
  const chat=await ensureChat(); if(!chat)return;
  const userContent=attachedFile?`${text}\n\n[Attached file: ${attachedFile.name}]\n${attachedFile.content}`:text;
  const msg={role:'user',content:text}; chat.messages.push(msg);
  if(chat.title==='New chat'){ chat.title=text.slice(0,42)+(text.length>42?'…':''); if(session&&supabase) supabase.from('conversations').update({title:chat.title,updated_at:new Date().toISOString()}).eq('id',chat.id).then(()=>{}); }
  try{ const saved=await persistMessage(chat,'user',text,attachedFile?.name||null); if(saved) msg.id=saved.id; }catch(e){toast('Message saved locally only.');}
  saveLocal(); renderAll();
  input.value=''; autosize(); const sentAttachment=attachedFile; attachedFile=null; fileChip.classList.add('hidden'); fileInput.value=''; sendBtn.disabled=true;
  emptyState.classList.add('hidden'); messagesEl.classList.remove('hidden'); const typing=addMessageToDOM('assistant','',true); scrollBottom();
  try{
    const history=chat.messages.slice(-12).map(m=>({role:m.role,content:m.content})); history[history.length-1].content=userContent;
    const headers={'Content-Type':'application/json'}; if(session?.access_token) headers.Authorization=`Bearer ${session.access_token}`;
    if(directFilePreview){
      toast('This ZIP is opened directly. You can inspect the app, but Live AI needs the backend to be running.');
      modeLabel.textContent='Preview only';
      modeLabel.closest('.status-dot-wrap')?.classList.add('offline');
      return;
    }
    const res=await fetch('/.netlify/functions/chat',{method:'POST',headers,body:JSON.stringify({messages:history})}); const data=await res.json();
    if(!res.ok) throw new Error(data.error||'Request failed'); modeLabel.textContent='Live AI'; typing.remove();
    const ai={role:'assistant',content:data.reply}; chat.messages.push(ai); try{const saved=await persistMessage(chat,'assistant',data.reply);if(saved)ai.id=saved.id;}catch{}
    if(data.usage) updateUsageDisplay(data.usage.used,data.usage.limit,data.usage.period);
  }catch(err){ typing.remove(); chat.messages.push({role:'assistant',content:`Ortiz AI could not complete that request. ${err.message}`}); modeLabel.textContent='Connection issue'; }
  saveLocal(); renderAll(); sendBtn.disabled=false; input.focus();
}

function planLabel(plan){ return ({free:'Free',plus:'Ortiz Plus',pro:'Ortiz Pro',admin:'Admin'})[plan] || 'Free'; }
function updateAccountUI(){
  const signed=!!session;
  const displayName=signed?(profile?.full_name?.trim()||session.user.email?.split('@')[0]||'Account'):'Guest';
  const plan= signed?(profile?.plan||'free'):'guest';
  $('#accountBtn').textContent=signed?(displayName.split(' ')[0]||'Account'):'Sign in';
  $('#sidebarSignOutBtn').classList.toggle('hidden',!signed);
  $('#planPill').textContent=signed?planLabel(plan):'Guest';
  $('#accountSubtitle').textContent=signed?session.user.email:'Your personal AI workspace';
  $('#adminBtn').classList.toggle('hidden',profile?.role!=='admin');
  $('#sidebarAccountName').textContent=displayName;
  $('#sidebarAccountEmail').textContent=signed?(session.user.email||'Signed in'):'Sign in to sync your chats';
  $('#sidebarAccountPlan').textContent=signed?`${planLabel(plan)} plan`:'Guest plan';
  document.querySelectorAll('[data-plan-action]').forEach(btn=>{
    const target=btn.dataset.planAction;
    const isCurrent=signed && target===plan;
    btn.disabled=isCurrent;
    btn.textContent=isCurrent
      ? 'Current plan'
      : (target==='free' ? 'Choose Free' : `Choose ${planLabel(target)}`);
  });
}
function updateUsageDisplay(used,limit,period='day'){
  const suffix=limit===null?'unlimited':(period==='month'?'this month':'today');
  $('#profileUsage').textContent=limit===null?`${used} used · unlimited`:`${used} / ${limit} ${suffix}`;
}

async function loadProfile(){
  if(!session||!supabase){profile=null;updateAccountUI();return;}
  const {data,error}=await supabase.from('profiles').select('id,full_name,role,plan,is_active,created_at').eq('id',session.user.id).single();
  if(error){console.error(error);return;} profile=data; updateAccountUI();
}

function openAccount(){
  if(session){
    $('#profileEmail').textContent=session.user.email||'—';
    $('#profilePlan').textContent=planLabel(profile?.plan||'free');
    $('#profileRole').textContent=profile?.role||'user';
    openModal('accountModal');
  } else {
    if(!cloudReady){toast('Cloud sign-in is unavailable right now.');return;}
    setAuthMode('signin');openModal('authModal');
  }
}
$('#accountBtn').onclick=openAccount;
$('#sidebarAccountCard').onclick=()=>{ closeSidebar(); openAccount(); };
$('#plansBtn').onclick=()=>{ closeSidebar(); openModal('plansModal'); updateAccountUI(); };
document.querySelectorAll('[data-plan-action]').forEach(btn=>btn.onclick=()=>{
  const target=btn.dataset.planAction;
  if(target===profile?.plan) return;

  if(!session){
    closeModal('plansModal');
    if(!cloudReady){
      toast('Sign-in must be available before choosing a paid plan.');
      return;
    }
    setAuthMode('signin');
    openModal('authModal');
    toast('Sign in first, then choose your plan.');
    return;
  }

  if(target==='free'){
    if(profile?.plan==='free') return;
    toast('Downgrades are handled at the end of the current paid billing period.');
    return;
  }

  const checkoutUrl=cfg.billingUrls?.[target];
  if(!checkoutUrl){
    toast(`${planLabel(target)} checkout is not connected yet.`);
    return;
  }

  try{
    const url=new URL(checkoutUrl,window.location.href);
    url.searchParams.set('client_reference_id',session.user.id);
    if(session.user.email) url.searchParams.set('prefilled_email',session.user.email);
    window.location.href=url.toString();
  }catch{
    toast(`The ${planLabel(target)} checkout link is invalid.`);
  }
});
function showAuthError(message){
  const el=$('#authError');
  el.textContent=message;
  el.classList.remove('hidden');
}

function setAuthMode(mode){
  authMode=mode;
  const signup=mode==='signup';
  $('#authTitle').textContent=signup?'Create your Ortiz AI account':'Welcome back';
  $('#authHint').textContent=signup
    ? 'Create an account with email or Google to sync your chats.'
    : 'Sign in with email or Google to sync your conversations across devices.';
  $('#nameField').classList.toggle('hidden',!signup);
  $('#authSubmit').textContent=signup?'Create account':'Sign in';
  $('#authSwitch').textContent=signup?'Already have an account? Sign in':'Create an account';
  $('#authPassword').autocomplete=signup?'new-password':'current-password';
  $('#authError').classList.add('hidden');
}

$('#authSwitch').onclick=()=>setAuthMode(authMode==='signin'?'signup':'signin');

$('#googleAuthBtn').onclick=async()=>{
  if(!supabase||!cloudReady){
    showAuthError('Google sign-in is unavailable right now.');
    return;
  }
  if(directFilePreview){
    showAuthError('Google sign-in cannot complete from an unzipped file. It works when Ortiz AI is opened from a web address.');
    return;
  }

  $('#googleAuthBtn').disabled=true;
  const redirectTo=window.location.origin + window.location.pathname;
  const {error}=await supabase.auth.signInWithOAuth({
    provider:'google',
    options:{redirectTo}
  });
  $('#googleAuthBtn').disabled=false;

  if(error){
    const msg=(error.message||'').toLowerCase();
    showAuthError(
      msg.includes('provider') && msg.includes('enabled')
        ? 'Google sign-in is not enabled yet for Ortiz AI.'
        : error.message
    );
  }
};

$('#authForm').onsubmit=async e=>{
  e.preventDefault();
  const email=$('#authEmail').value.trim();
  const password=$('#authPassword').value;
  const name=$('#authName').value.trim();

  $('#authSubmit').disabled=true;
  $('#authError').classList.add('hidden');

  let result;
  if(authMode==='signup'){
    result=await supabase.auth.signUp({
      email,
      password,
      options:{data:{full_name:name}}
    });
  }else{
    result=await supabase.auth.signInWithPassword({email,password});
  }

  $('#authSubmit').disabled=false;

  if(result.error){
    const msg=(result.error.message||'').toLowerCase();
    const duplicate=
      msg.includes('already registered') ||
      msg.includes('already exists') ||
      msg.includes('user already');

    if(authMode==='signup' && duplicate){
      showAuthError('This account already exists. Please sign in instead.');
      $('#authSwitch').textContent='Sign in instead';
      return;
    }

    showAuthError(result.error.message);
    return;
  }

  if(authMode==='signup'){
    const identities=result.data?.user?.identities;
    if(Array.isArray(identities) && identities.length===0){
      showAuthError('This account already exists. Please sign in instead.');
      $('#authSwitch').textContent='Sign in instead';
      return;
    }

    if(!result.data.session){
      toast('Check your email to confirm your account.');
      closeModal('authModal');
      return;
    }
  }

  closeModal('authModal');
};
async function signOut(){ if(supabase) await supabase.auth.signOut(); closeModal('accountModal'); }
$('#accountSignOutBtn').onclick=signOut; $('#signOutBtn').onclick=signOut; $('#sidebarSignOutBtn').onclick=async()=>{ closeSidebar(); await signOut(); };

async function loadAdmin(){
  if(profile?.role!=='admin'||!supabase)return; $('#adminStats').innerHTML='<div class="stat-card">Loading…</div>'; $('#adminUsers').innerHTML='';
  const [{data:users,error:uerr},{data:usage,error:err2}]=await Promise.all([supabase.from('profiles').select('id,full_name,plan,is_active,created_at').order('created_at',{ascending:false}).limit(100),supabase.from('usage_events').select('id,user_id,created_at').gte('created_at',new Date(new Date().setHours(0,0,0,0)).toISOString())]);
  if(uerr||err2){toast((uerr||err2).message);return;} const active=(users||[]).filter(u=>u.is_active).length;
  $('#adminStats').innerHTML=`<div class="stat-card"><span>Users</span><strong>${users?.length||0}</strong></div><div class="stat-card"><span>Active</span><strong>${active}</strong></div><div class="stat-card"><span>AI requests today</span><strong>${usage?.length||0}</strong></div>`;
  $('#adminUsers').innerHTML=(users||[]).map(u=>`<tr><td>${escapeHtml(u.full_name||u.id.slice(0,8))}</td><td>${escapeHtml(u.plan)}</td><td>${u.is_active?'Active':'Disabled'}</td><td>${new Date(u.created_at).toLocaleDateString()}</td></tr>`).join('');
}
function escapeHtml(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
$('#adminBtn').onclick=()=>{openModal('adminModal');loadAdmin();}; $('#refreshAdminBtn').onclick=loadAdmin;

$('#newChatBtn').onclick=async()=>{await createChat();closeSidebar();input.focus();};
$('#clearAllBtn').onclick=async()=>{ if(!confirm('Clear all Ortiz AI chat history?'))return; if(session&&supabase&&chats.length){const {error}=await supabase.from('conversations').delete().eq('user_id',session.user.id);if(error){toast(error.message);return;}} chats=[];currentChatId=null;localStorage.removeItem('ortiz-ai-chats');localStorage.removeItem('ortiz-ai-current');renderAll();};
$('#attachBtn').onclick=()=>fileInput.click(); fileInput.onchange=async()=>{const f=fileInput.files?.[0];if(!f)return;if(f.size>500000){alert('Please use a text file smaller than 500 KB.');fileInput.value='';return;}attachedFile={name:f.name,content:await f.text()};fileChip.textContent=`Attached: ${f.name} · ${Math.ceil(f.size/1024)} KB`;fileChip.classList.remove('hidden');};
input.addEventListener('input',autosize); input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}}); sendBtn.onclick=()=>sendMessage(); document.querySelectorAll('.suggestion').forEach(b=>b.onclick=()=>sendMessage(b.dataset.prompt));
function applyTheme(theme){
  const chosen=theme==='light'?'light':'dark';
  document.body.classList.toggle('light-theme',chosen==='light');
  localStorage.setItem('ortiz-ai-theme',chosen);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',chosen==='light'?'#f5f7fb':'#090b12');
  $('#lightThemeBtn')?.classList.toggle('active',chosen==='light');
  $('#darkThemeBtn')?.classList.toggle('active',chosen==='dark');
}
applyTheme(localStorage.getItem('ortiz-ai-theme')||'dark');
$('#lightThemeBtn').onclick=()=>applyTheme('light');
$('#darkThemeBtn').onclick=()=>applyTheme('dark');
const sidebar=$('#sidebar');
$('#menuBtn').onclick=()=>sidebar.classList.toggle('open');
$('#sidebarCloseBtn').onclick=closeSidebar;
function closeSidebar(){sidebar.classList.remove('open');}
document.addEventListener('keydown',(event)=>{ if(event.key==='Escape') closeSidebar(); });
document.addEventListener('click',(event)=>{
  if(window.innerWidth>820 || !sidebar.classList.contains('open')) return;
  const openedFromMenu=$('#menuBtn').contains(event.target);
  if(!sidebar.contains(event.target) && !openedFromMenu) closeSidebar();
});


// Voice input: uses the browser's SpeechRecognition API when available.
const micBtn=$('#micBtn');
let speechRecognition=null;
let speechListening=false;
const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
if(SpeechRecognition){
  speechRecognition=new SpeechRecognition();
  speechRecognition.lang=document.documentElement.lang||'en-US';
  speechRecognition.interimResults=true;
  speechRecognition.continuous=false;
  let finalTranscript='';
  speechRecognition.onstart=()=>{
    speechListening=true;
    finalTranscript='';
    micBtn.classList.add('listening');
    micBtn.textContent='●';
    micBtn.title='Listening… tap to stop';
  };
  speechRecognition.onresult=(event)=>{
    let interim='';
    for(let i=event.resultIndex;i<event.results.length;i++){
      const text=event.results[i][0].transcript;
      if(event.results[i].isFinal) finalTranscript+=text;
      else interim+=text;
    }
    const spoken=(finalTranscript+interim).trim();
    if(spoken){
      input.value=spoken;
      autosize();
      input.focus();
    }
  };
  speechRecognition.onerror=(event)=>{
    if(event.error!=='aborted' && event.error!=='no-speech'){
      toast(`Microphone: ${event.error==='not-allowed'?'permission denied':event.error}`);
    }
  };
  speechRecognition.onend=()=>{
    speechListening=false;
    micBtn.classList.remove('listening');
    micBtn.textContent='🎤';
    micBtn.title='Speak to Ortiz AI';
    input.focus();
  };
  micBtn.onclick=()=>{
    try{
      if(speechListening) speechRecognition.stop();
      else speechRecognition.start();
    }catch(e){
      toast('Microphone is already starting. Please try again.');
    }
  };
}else{
  micBtn.onclick=()=>toast('Voice input is not supported in this browser. Try Chrome or another browser with speech recognition.');
}



async function checkAIStatus(){
  if(directFilePreview){
    modeLabel.textContent='Preview only';
    modeLabel.closest('.status-dot-wrap')?.classList.add('offline');
    return;
  }
  try{
    const res=await fetch('/.netlify/functions/chat',{method:'GET',cache:'no-store'});
    if(!res.ok) throw new Error('AI server unavailable');
    const data=await res.json();
    modeLabel.textContent=data.live?'Live AI':'AI setup required';
    modeLabel.closest('.status-dot-wrap')?.classList.toggle('offline',!data.live);
  }catch{
    modeLabel.textContent='AI server offline';
    modeLabel.closest('.status-dot-wrap')?.classList.add('offline');
  }
}

async function initCloud(){
  if(!cloudConfigured){
    modeLabel.textContent='AI server offline';
    return;
  }
  try{
    const mod=await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.4/+esm');
    supabase=mod.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey);
    cloudReady=true;
    const {data:{session:initial}}=await supabase.auth.getSession();
    session=initial;
    await loadProfile();
    if(session) await loadCloudChats();
    supabase.auth.onAuthStateChange((_event,newSession)=>{
      setTimeout(async()=>{
        session=newSession;
        await loadProfile();
        if(session) await loadCloudChats();
        else{
          chats=[];currentChatId=null;
          localStorage.removeItem('ortiz-ai-chats');
          localStorage.removeItem('ortiz-ai-current');
          renderAll();
        }
      },0);
    });
    updateAccountUI();
  }catch(err){
    console.error('Supabase failed to load:',err);
    cloudReady=false;
    modeLabel.textContent='AI server offline';
    toast('Account sync is unavailable. Live AI still requires the Ortiz AI server connection.');
  }
}

renderAll();
if(directFilePreview){
  setTimeout(()=>toast('Direct file preview: UI works, but Live AI cannot run from an unzipped HTML file.'),300);
}
checkAIStatus();
initCloud();
