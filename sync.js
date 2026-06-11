/* ============================================================
   서버 동기화 (Firebase Firestore) — 선택 기능
   - 관리자(행보관): 로그인하면 수정 가능, 저장할 때마다 자동 업로드
   - 구성원: 열람 계정으로 로그인 → 읽기 전용 + 실시간 수신
   - 미설정/오프라인/로그아웃: 기존처럼 localStorage 단독으로 동작
   실제 권한은 Firestore 보안 규칙이 강제한다 (FIREBASE_SETUP.md).
   engine.js·index.html의 전역(DB, save, refreshAll 등)을 사용하므로
   반드시 그 뒤에 로드해야 한다.
   ============================================================ */
"use strict";
(function(){
  const CFG_KEY='cctv_sync_cfg_v1';
  const qs=s=>document.querySelector(s);
  const S={ on:false, admin:false, readonly:false, user:null, dirty:false,
            lastUp:null, lastDown:null, timer:null };
  window.SYNC=S; // 디버그용

  /* ---------- 설정 로드: localStorage > firebase-config.js ---------- */
  function loadCfg(){
    try{
      const c=JSON.parse(localStorage.getItem(CFG_KEY)||'null');
      if(c && c.config && c.config.apiKey) return c;
    }catch(e){}
    if(window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey){
      return {config:window.FIREBASE_CONFIG, adminEmail:String(window.FIREBASE_ADMIN_EMAIL||'')};
    }
    return null;
  }
  function status(html){ const b=qs('#syStatus'); if(b) b.innerHTML=html; }
  function fmt(t){ return t ? t.toTimeString().slice(0,8) : '—'; }

  /* ---------- 연결 설정 폼 (연결 여부와 무관하게 동작) ---------- */
  // 콘솔에서 복사한 firebaseConfig는 키에 따옴표가 없는 JS 객체 표기라 JSON.parse가 안 됨
  function parseCfgText(t){
    const a=t.indexOf('{'), b=t.lastIndexOf('}');
    if(a<0 || b<a) throw new Error('설정 객체({ ... })를 찾을 수 없습니다');
    return (new Function('return ('+t.slice(a,b+1)+')'))();
  }
  qs('#syCfgSave').addEventListener('click',()=>{
    try{
      const c=parseCfgText(qs('#syCfg').value);
      if(!c.apiKey || !c.projectId) throw new Error('apiKey/projectId가 없습니다');
      const adminEmail=(qs('#syAdmin').value||'').trim();
      if(!adminEmail) throw new Error('관리자 이메일을 입력하세요');
      localStorage.setItem(CFG_KEY, JSON.stringify({config:c, adminEmail}));
      alert('연결 설정을 저장했습니다. 페이지를 새로고침합니다.');
      location.reload();
    }catch(e){ status('<div class="err">설정 저장 실패: '+esc(e.message)+'</div>'); }
  });
  qs('#syCfgClear').addEventListener('click',()=>{
    if(!confirm('이 브라우저의 동기화 설정을 삭제할까요? (서버의 데이터는 남습니다)')) return;
    localStorage.removeItem(CFG_KEY);
    location.reload();
  });

  const cfg=loadCfg();
  if(cfg){
    qs('#syCfg').value=JSON.stringify(cfg.config,null,2);
    qs('#syAdmin').value=cfg.adminEmail||'';
  }
  if(!cfg){
    status('<div class="warn">동기화 미설정 — 이 브라우저에만 저장됩니다. 아래 [연결 설정]에서 Firebase 설정을 입력하세요 (FIREBASE_SETUP.md 참고).</div>');
    qs('#syLoginRow').style.display='none';
    return;
  }
  if(typeof firebase==='undefined'){
    status('<div class="err">Firebase SDK를 불러오지 못했습니다 (오프라인?). 이 브라우저의 로컬 저장으로만 동작합니다.</div>');
    qs('#syLoginRow').style.display='none';
    return;
  }

  /* ---------- Firebase 초기화 ---------- */
  let auth, docRef;
  try{
    firebase.initializeApp(cfg.config);
    auth=firebase.auth();
    docRef=firebase.firestore().collection('roster').doc('main');
  }catch(e){
    status('<div class="err">Firebase 초기화 실패: '+esc(e.message)+'</div>');
    return;
  }
  S.on=true;

  /* ---------- 서버 → 로컬 반영 ---------- */
  function adopt(remoteJson){
    try{
      DB = migrate(JSON.parse(remoteJson));
      invalidateStats();
      // 오프라인 열람용 캐시 — save() 래퍼를 거치지 않고 직접 기록 (재업로드 방지)
      try{ localStorage.setItem(STORE_KEY, JSON.stringify(DB)); }catch(e){}
      S.lastDown=new Date();
      refreshAll();
      refreshStatus();
    }catch(e){ console.warn('서버 데이터 반영 실패', e); }
  }

  /* ---------- 로컬 → 서버 업로드 (관리자) ---------- */
  function upload(){
    if(!S.admin) return Promise.resolve();
    const json=JSON.stringify(DB);
    if(json.length>900000)
      alert('주의: 데이터가 900KB를 넘었습니다 (Firestore 문서 한도 1MB).\n[기본 설정]에서 JSON 백업 후 오래된 근무표 삭제를 권장합니다.');
    return docRef.set({json, updatedAt:firebase.firestore.FieldValue.serverTimestamp(), by:S.user?S.user.email:''})
      .then(()=>{ S.dirty=false; S.lastUp=new Date(); refreshStatus(); })
      .catch(e=>{ status('<div class="err">업로드 실패: '+esc(e.message)+' — 보안 규칙·관리자 이메일을 확인하세요.</div>'); });
  }
  function scheduleUpload(){ clearTimeout(S.timer); S.timer=setTimeout(upload, 1500); }

  /* ---------- save() 래핑: 관리자=자동 업로드 예약, 열람=차단 ---------- */
  const _save=save;
  save=function(){
    if(S.on && S.readonly){
      alert('열람 전용 모드입니다 — 변경 사항은 저장되지 않습니다.');
      docRef.get().then(d=>{ const x=d.data(); if(x&&x.json) adopt(x.json); }).catch(()=>{});
      return;
    }
    _save();
    if(S.on && S.admin){ S.dirty=true; scheduleUpload(); }
  };

  /* ---------- 열람 전용 모드 ---------- */
  function applyReadonly(){
    document.body.classList.toggle('ro', !!S.readonly);
    const badge=qs('#roBadge'); if(badge) badge.style.display=S.readonly?'':'none';
    refreshAll();
  }

  /* ---------- 실시간 구독 ---------- */
  let unsub=null, adminBooted=false;
  function subscribe(){
    if(unsub){ unsub(); unsub=null; }
    unsub=docRef.onSnapshot(snap=>{
      if(!snap.exists){
        if(S.admin) upload();                       // 서버가 비어 있으면 관리자 로컬 데이터로 초기화
        return;
      }
      if(snap.metadata.hasPendingWrites) return;    // 내 쓰기의 에코
      const d=snap.data();
      if(!d || !d.json) return;
      if(S.admin){
        // 관리자는 접속 직후 1회만 서버와 대조 — 이후엔 이 브라우저가 원본
        if(!adminBooted){
          adminBooted=true;
          if(d.json!==JSON.stringify(DB)){
            if(confirm('서버에 저장된 데이터가 이 브라우저와 다릅니다.\n[확인] 서버 데이터를 불러옵니다 (이 브라우저 데이터 대체)\n[취소] 이 브라우저 데이터를 서버에 업로드합니다'))
              adopt(d.json);
            else upload();
          }
        }
        refreshStatus();
        return;
      }
      adopt(d.json);                                 // 구성원: 항상 서버 데이터 수신
    }, e=>{
      status('<div class="err">실시간 수신 오류: '+esc(e.message)+' — 보안 규칙과 로그인 상태를 확인하세요.</div>');
    });
  }

  /* ---------- 로그인 UI ---------- */
  function toggleLoginUI(){
    const inB=qs('#syLogin'), outB=qs('#syLogout'), upB=qs('#syUpload');
    const em=qs('#syEmail'), pw=qs('#syPass');
    const logged=!!S.user;
    em.parentElement.style.display = logged?'none':'';
    pw.parentElement.style.display = logged?'none':'';
    inB.style.display = logged?'none':'';
    outB.style.display = logged?'':'none';
    upB.style.display = (logged&&S.admin)?'':'none';
  }
  function refreshStatus(){
    if(!S.user){
      status('<div class="warn">연결됨 — 로그인하세요. 로그인 전에는 이 브라우저에만 저장됩니다.</div>');
      return;
    }
    if(S.admin){
      status('<div class="ok">✓ 관리자 모드 · '+esc(S.user.email)+' · 마지막 업로드 '+fmt(S.lastUp)+(S.dirty?' · <b>업로드 대기 중…</b>':'')+'</div>');
    }else{
      status('<div class="ok">✓ 열람 전용 · '+esc(S.user.email)+' · 실시간 수신 중 · 마지막 수신 '+fmt(S.lastDown)+'</div>');
    }
  }
  qs('#syLogin').addEventListener('click',()=>{
    const em=(qs('#syEmail').value||'').trim(), pw=qs('#syPass').value;
    if(!em||!pw){ status('<div class="err">이메일과 비밀번호를 입력하세요.</div>'); return; }
    auth.signInWithEmailAndPassword(em,pw)
      .catch(e=>status('<div class="err">로그인 실패: '+esc(e.message)+'</div>'));
  });
  qs('#syLogout').addEventListener('click',()=>auth.signOut());
  qs('#syUpload').addEventListener('click',()=>{ upload().then(()=>status('<div class="ok">✓ 업로드 완료</div>')); });

  auth.onAuthStateChanged(u=>{
    S.user=u;
    if(u){
      S.admin = !!cfg.adminEmail && (u.email||'').toLowerCase()===cfg.adminEmail.toLowerCase();
      S.readonly = !S.admin;
      adminBooted=false;
      subscribe();
    }else{
      S.admin=false; S.readonly=false;
      if(unsub){ unsub(); unsub=null; }
    }
    applyReadonly();
    toggleLoginUI();
    refreshStatus();
  });
})();
