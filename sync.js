/* ============================================================
   서버 동기화 (Firebase Firestore) — 선택 기능
   - 관리자(행보관): 로그인하면 수정 가능, 저장할 때마다 자동 업로드
   - 구성원: 열람 계정으로 로그인 → 읽기 전용 + 실시간 수신
   - 미설정/오프라인/로그아웃: 기존처럼 localStorage 단독으로 동작
   저장 구조: roster/meta(근무자·설정 등 공통) + roster/m-YYYY-MM(월별 근무표).
   구버전 단일 문서(roster/main)는 관리자 접속 시 자동 변환 후 삭제된다.
   실제 권한은 Firestore 보안 규칙이 강제한다 (FIREBASE_SETUP.md).
   engine.js·index.html의 전역(DB, save, refreshAll 등)을 사용하므로
   반드시 그 뒤에 로드해야 한다.
   ============================================================ */
"use strict";
(function(){
  const CFG_KEY='cctv_sync_cfg_v1';
  const MTIME_KEY='cctv_local_mtime_v1';   // 로컬 마지막 수정시각 — index.html save()가 기록
  const qs=s=>document.querySelector(s);
  const S={ on:false, admin:false, readonly:false, user:null, dirty:false,
            lastUp:null, lastDown:null, timer:null, remote:{}, remoteAt:0, note:'',
            member:null, legacy:false, denied:false, signingUp:false, unitCode:null, dirJson:'', pendingDir:null,
            authReady:false, memberLoading:false, live:false, liveErr:null, lastSig:'', lastPhase:null };
  window.SYNC=S; // 디버그용
  /* 로그인 복원 힌트 — 지난번 이 기기에서 누구로 로그인했는지(구성원이면 앱을 열자마자 관리자 화면 대신 '확인 중'을 보여 줌).
     권한과 무관한 표시용 값이며, 실제 권한은 인증·보안 규칙이 정한다. */
  const HINT_KEY='cctv_role_hint_v1', RECV_KEY='cctv_last_recv_v1';
  function readHint(){ try{ return JSON.parse(localStorage.getItem(HINT_KEY)||'null'); }catch(e){ return null; } }
  function writeHint(h){ try{ if(h) localStorage.setItem(HINT_KEY, JSON.stringify(h)); else localStorage.removeItem(HINT_KEY); }catch(e){} }
  /* 마지막으로 서버에서 근무표를 받은 시각(계정별) — 화면을 그린 시각이 아니라 실제 수신 시각 */
  function setLastRecv(t){ S.lastRecv=t; try{ if(S.user) localStorage.setItem(RECV_KEY, JSON.stringify({uid:S.user.uid, at:t})); }catch(e){} }
  function storedRecv(){ try{ const r=JSON.parse(localStorage.getItem(RECV_KEY)||'null'); return r && S.user && r.uid===S.user.uid ? r.at : null; }catch(e){ return null; } }
  /* 로그인 단계 — index.html의 내 근무 화면이 이 값으로 로그인·가입·개인 홈을 고른다 */
  function phase(){
    if(!S.authReady) return 'auth';
    if(!S.user) return 'guest';
    if(S.admin) return 'admin';
    if(S.memberLoading) return 'loading';
    if(S.memberErr) return 'error';
    if(S.member) return 'member';
    if(S.legacy) return 'legacy';
    if(S.signingUp || S.denied || S.pendingDir || !unsub) return 'join';
    return 'loading';   // 등록 없이 구독 중 — 공용 계정인지(읽힘) 등록이 필요한지(거부) 곧 판정됨
  }
  function notifyPhase(){
    const p=phase();
    document.body.classList.toggle('guest', p==='guest');
    if(window.onSyncPhase) window.onSyncPhase(p);
  }
  window.addEventListener('online', ()=>notifyPhase());
  window.addEventListener('offline', ()=>{ S.live=false; notifyPhase(); });

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
    // 연결 설정이 이미 있으면(내장 firebase-config.js 또는 저장된 설정) 설정 폼은 숨긴다
    const box=qs('#sySetup'); if(box) box.style.display='none';
  }
  if(!cfg){
    window.SYNC_UNAVAILABLE='nocfg';
    status('<div class="warn">동기화 미설정 — 이 브라우저에만 저장됩니다. 아래 [⚙ 연결 설정]에 Firebase 설정을 입력하세요 (FIREBASE_SETUP.md 참고).</div>');
    qs('#syLoginRow').style.display='none';
    return;
  }
  if(typeof firebase==='undefined'){
    window.SYNC_UNAVAILABLE='sdk';
    status('<div class="err">Firebase SDK를 불러오지 못했습니다 (오프라인?). 이 브라우저의 로컬 저장으로만 동작합니다.</div>');
    qs('#syLoginRow').style.display='none';
    return;
  }

  /* ---------- Firebase 초기화 ---------- */
  let auth, col, fs;
  try{
    firebase.initializeApp(cfg.config);
    auth=firebase.auth();
    fs=firebase.firestore();
    col=fs.collection('roster');
  }catch(e){
    window.SYNC_UNAVAILABLE='init';
    status('<div class="err">Firebase 초기화 실패: '+esc(e.message)+'</div>');
    return;
  }
  S.on=true;

  /* ---------- 분할 저장 헬퍼 ----------
     meta(근무자·사전등록·휴무일·설정) + 월별 근무표(m-YYYY-MM, 매월 1일 기준 달력 월)로
     나눠 문서별 JSON 문자열을 만든다. S.remote는 실시간 구독으로 유지되는 서버 사본. */
  const MONTH_DOC=/^m-\d{4}-\d{2}$/;
  function splitLocal(){
    const parts={ meta: JSON.stringify({version:DB.version, lastBackupAt:DB.lastBackupAt,
      workers:DB.workers, prebook:DB.prebook, holidays:DB.holidays, settings:DB.settings}) };
    const byMonth={};
    Object.keys(DB.schedules).sort().forEach(ds=>{
      const id='m-'+ds.slice(0,7);
      (byMonth[id]=byMonth[id]||{})[ds]=DB.schedules[ds];
    });
    Object.keys(byMonth).forEach(id=>{ parts[id]=JSON.stringify(byMonth[id]); });
    return parts;
  }
  /* 서버 사본을 DB 객체로 조립 — 신형식(meta+월별) 우선, 구형식(main 단일 문서) 폴백 */
  function buildRemoteDB(){
    try{
      if(S.remote.meta){
        const obj=JSON.parse(S.remote.meta);
        obj.schedules={};
        Object.keys(S.remote).forEach(id=>{
          if(MONTH_DOC.test(id)) Object.assign(obj.schedules, JSON.parse(S.remote[id]));
        });
        return obj;
      }
      if(S.remote.main) return JSON.parse(S.remote.main);
    }catch(e){ console.warn('서버 데이터 해석 실패', e); }
    return null;
  }
  function remoteEqualsLocal(){
    if(S.remote.meta){
      const parts=splitLocal();
      const ids=Object.keys(S.remote).filter(id=> id==='meta'||MONTH_DOC.test(id));
      return ids.length===Object.keys(parts).length && ids.every(id=> S.remote[id]===parts[id]);
    }
    if(S.remote.main) return S.remote.main===JSON.stringify(DB);   // 구형식 비교(전환 전 1회용)
    return false;
  }

  /* ---------- 서버 → 로컬 반영 ---------- */
  function adopt(obj){
    try{
      DB = migrate(obj);
      invalidateStats();
      // 오프라인 열람용 캐시 — save() 래퍼를 거치지 않고 직접 기록 (재업로드 방지)
      // 수정시각은 서버 기준으로 맞춰 다음 접속의 최신 비교가 어긋나지 않게 한다
      try{
        localStorage.setItem(STORE_KEY, JSON.stringify(DB));
        localStorage.setItem(MTIME_KEY, String(S.remoteAt||Date.now()));
      }catch(e){}
      S.lastDown=new Date();
      refreshAll();
      refreshStatus();
    }catch(e){ console.warn('서버 데이터 반영 실패', e); }
  }

  /* ---------- 로컬 → 서버 업로드 (관리자) ----------
     서버 사본(S.remote)과 다른 문서만 batch로 쓰고, 로컬에 없는 월 문서와
     구형식 문서(main 등)는 삭제한다 → 보통 저장 1회에 문서 1~2개만 쓴다. */
  function upload(){
    if(!S.admin) return Promise.resolve();
    const parts=splitLocal();
    Object.keys(parts).forEach(id=>{
      if(parts[id].length>900000)
        alert('주의: 문서 '+id+'가 900KB를 넘었습니다 (Firestore 문서 한도 1MB).\n[기본 설정]에서 JSON 백업 후 오래된 근무표 삭제를 권장합니다.');
    });
    const batch=firebase.firestore().batch();
    let ops=0;
    const stamp=()=>({updatedAt:firebase.firestore.FieldValue.serverTimestamp(), by:S.user?S.user.email:''});
    Object.keys(parts).forEach(id=>{
      if(S.remote[id]===parts[id]) return;
      batch.set(col.doc(id), Object.assign({json:parts[id]}, stamp())); ops++;
    });
    Object.keys(S.remote).forEach(id=>{
      if(!(id in parts)){ batch.delete(col.doc(id)); ops++; }   // 삭제된 월 + 구형식(main) 정리
    });
    // 가입 화면의 본인 선택 목록 — 바뀐 경우에만 쓴다
    const dj=dirPayloadJson();
    if(S.unitCode && dj!==S.dirJson){ batch.set(fs.collection('directory').doc(S.unitCode), {json:dj, updatedAt:firebase.firestore.FieldValue.serverTimestamp()}); ops++; }
    if(!ops){ S.dirty=false; refreshStatus(); return Promise.resolve(true); }
    return batch.commit()
      .then(()=>{ S.dirty=false; S.lastUp=new Date(); S.dirJson=dj; refreshStatus(); return true; })
      .catch(e=>{ status('<div class="err">업로드 실패: '+esc(e.message)+' — 보안 규칙·관리자 이메일을 확인하세요.</div>'); return false; });
  }
  function scheduleUpload(){ clearTimeout(S.timer); S.timer=setTimeout(upload, 1500); }

  /* ---------- save() 래핑: 관리자=자동 업로드 예약, 열람=차단 ---------- */
  const _save=save;
  save=function(){
    if(S.on && S.readonly){
      alert('열람 전용 모드입니다 — 변경 사항은 저장되지 않습니다.');
      const r=buildRemoteDB(); if(r) adopt(r);   // 실시간 사본으로 되돌림
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

  /* ---------- 실시간 구독 (roster 컬렉션 전체) ---------- */
  let unsub=null, adminBooted=false;
  function subscribe(){
    if(unsub){ unsub(); unsub=null; }
    // 구성원은 캐시/서버 전환도 받아 '최신 확인' 여부를 실제 수신 상태로 표시한다(관리자 흐름은 종전 그대로)
    const onSnap = snap=>{
      if(snap.metadata.hasPendingWrites) return;    // 내 쓰기의 에코 (서버 확정 후 다시 옴)
      const remote={};
      let remoteAt=0;
      snap.forEach(doc=>{
        const d=doc.data(); if(!d||!d.json) return;
        remote[doc.id]=d.json;
        const t=(d.updatedAt&&d.updatedAt.toMillis)?d.updatedAt.toMillis():0;
        if(t>remoteAt) remoteAt=t;
      });
      const fromCache=!!(snap.metadata && snap.metadata.fromCache);
      // 구성원: 캐시에서 온 빈 결과(오프라인 등)는 '근무표 없음'이 아니라 '아직 못 받음' — 반영하지 않는다
      if(!S.admin && fromCache && !Object.keys(remote).length){ S.live=false; notifyPhase(); return; }
      S.remote=remote; S.remoteAt=remoteAt;
      if(S.denied){ S.denied=false; renderJoin(); }
      if(!S.admin && !S.member && !S.legacy){ S.legacy=true; renderJoin(); refreshStatus(); }   // 등록 없이 읽힘 = 전환 기간 공용 계정
      if(!Object.keys(remote).length){
        if(S.admin) upload();                       // 서버가 비어 있으면 관리자 로컬 데이터로 초기화
        return;
      }
      if(S.admin){
        // 접속 직후 1회: 서버와 로컬이 다르면 마지막 수정시각이 더 최신인 쪽을 자동 반영
        if(!adminBooted){
          adminBooted=true;
          if(!remoteEqualsLocal()){
            const localAt=Number(localStorage.getItem(MTIME_KEY))||0;
            if(S.remoteAt>localAt){
              const r=buildRemoteDB(); if(r) adopt(r);
              S.note='서버가 더 최신이라 자동으로 불러옴';
            }else{
              S.note='이 기기가 더 최신이라 서버에 업로드';
            }
            scheduleUpload();   // 반영 결과 기준으로 서버 정리(신형식 전환·main 삭제 포함) — 차이 없으면 0회 쓰기
          }else if(S.remote.main){
            scheduleUpload();   // 내용은 같지만 구형식(main) → 월별 분할로 전환 + main 삭제
          }
          refreshStatus();
          return;
        }
        // 이후: 같은 관리자 계정의 다른 기기에서 올린 변경도 실시간 수신
        // 단, 이 기기의 변경이 업로드 대기 중(dirty)이면 보류 — 업로드가 우선
        if(!S.dirty && !remoteEqualsLocal()){ const r=buildRemoteDB(); if(r) adopt(r); }
        refreshStatus();
        return;
      }
      // 구성원: 내용이 바뀐 경우에만 반영(캐시↔서버 전환만 온 경우엔 상태만 갱신)
      const sig=JSON.stringify(remote);
      if(!fromCache){ S.live=true; S.liveErr=null; setLastRecv(Date.now()); }
      else S.live=false;
      if(sig!==S.lastSig){ S.lastSig=sig; const r=buildRemoteDB(); if(r) adopt(r); }
      notifyPhase();
    };
    const onErr = e=>{
      S.live=false; S.liveErr=e && (e.code||e.message) || 'error';
      if(e && e.code==='permission-denied' && !S.admin && !S.member){
        S.denied=true; renderJoin(); notifyPhase();
        status(S.pendingDir ? '<div class="ok">✓ 부대 코드 확인 — 아래에서 본인을 선택하면 근무표를 볼 수 있습니다.</div>'
                            : '<div class="warn">부대 코드로 본인 확인을 마쳐야 근무표를 볼 수 있습니다. 아래에서 부대 코드를 입력하세요.</div>');
        return;
      }
      status('<div class="err">실시간 수신 오류: '+esc(e.message)+' — 보안 규칙과 로그인 상태를 확인하세요.</div>');
      notifyPhase();
    };
    unsub = S.admin ? col.onSnapshot(onSnap, onErr) : col.onSnapshot({includeMetadataChanges:true}, onSnap, onErr);
  }

  /* ---------- 로그인 UI ---------- */
  let loginMode='in';   // 'in' 로그인 / 'up' 회원가입
  function toggleLoginUI(){
    const inB=qs('#syLogin'), outB=qs('#syLogout'), upB=qs('#syUpload'), suB=qs('#sySignup');
    const em=qs('#syEmail'), pw=qs('#syPass');
    const logged=!!S.user, up=!logged && loginMode==='up';
    qs('#syMode').style.display = logged?'none':'';
    em.parentElement.style.display = logged?'none':'';
    pw.parentElement.style.display = logged?'none':'';
    qs('#syPass2').parentElement.style.display = up?'':'none';
    qs('#syJoinCode').parentElement.style.display = up?'':'none';
    inB.style.display = (logged||up)?'none':'';
    suB.style.display = up?'':'none';
    outB.style.display = logged?'':'none';
    upB.style.display = (logged&&S.admin)?'':'none';
    document.querySelectorAll('#syMode button').forEach(b=>b.classList.toggle('on', b.dataset.m===loginMode));
    qs('#syAdminBox').style.display = (logged&&S.admin)?'':'none';
  }
  document.querySelectorAll('#syMode button').forEach(b=>b.addEventListener('click',()=>{ loginMode=b.dataset.m; toggleLoginUI(); refreshStatus(); }));
  function refreshStatus(){
    if(!S.user){
      status(loginMode==='up'
        ? '<div class="warn">회원가입 — 이메일·비밀번호와 행보관에게 받은 <b>부대 코드</b>를 입력하세요. 코드가 맞아야 가입됩니다.</div>'
        : '<div class="warn">연결됨 — 로그인하세요. 계정이 없으면 [회원가입]을 누르세요. 로그인 전에는 이 브라우저에만 저장됩니다.</div>');
      return;
    }
    if(S.denied){ return; }
    if(S.admin){
      status('<div class="ok">✓ 관리자 모드 · '+esc(S.user.email)+' · 마지막 업로드 '+fmt(S.lastUp)+(S.dirty?' · <b>업로드 대기 중…</b>':'')+(S.note?' · '+esc(S.note):'')+'</div>');
    }else{
      const who = S.member ? ' · '+esc(nameOf(S.member.workerId)) : S.legacy ? ' · 공용 열람 계정' : '';
      status('<div class="ok">✓ 열람 전용'+who+' · '+esc(S.user.email)+' · 실시간 수신 중 · 마지막 수신 '+fmt(S.lastDown)+'</div>');
    }
  }
  qs('#syLogin').addEventListener('click',()=>{
    const em=(qs('#syEmail').value||'').trim(), pw=qs('#syPass').value;
    if(!em||!pw){ status('<div class="err">이메일과 비밀번호를 입력하세요.</div>'); return; }
    auth.signInWithEmailAndPassword(em,pw)
      .catch(e=>status('<div class="err">로그인 실패: '+esc(authMsg(e))+'</div>'));
  });
  qs('#syLogout').addEventListener('click',()=>auth.signOut());
  qs('#syUpload').addEventListener('click',()=>{ upload().then(ok=>{ if(ok) status('<div class="ok">✓ 업로드 완료</div>'); }); });

  auth.onAuthStateChanged(u=>{
    const prevUid=S.user && S.user.uid;
    S.user=u; S.member=null; S.legacy=false; S.denied=false; S.live=false; S.liveErr=null; S.lastSig='';
    S.authReady=true;
    // 로그인 상태를 복원하는 동안에는 지난번 본인 연결을 임시로 유지(같은 계정일 때만) — 빈 화면 대신 '확인 중'
    const hint=readHint();
    window.MY_WORKER = (u && hint && hint.role==='member' && hint.uid===u.uid) ? hint.wid : null;
    if(u){
      S.admin = !!cfg.adminEmail && (u.email||'').toLowerCase()===cfg.adminEmail.toLowerCase();
      S.readonly = !S.admin;
      S.memberLoading = !S.admin;
      adminBooted=false;
      if(S.admin) writeHint({role:'admin'});
      const ready = S.admin ? loadAdmin() : loadMember(u);
      // 가입 중에는 부대 코드 확인이 끝날 때까지 구독을 미룬다(권한 없음 안내가 결과 메시지를 덮지 않게)
      ready.then(()=>{
        if(S.user!==u) return;
        S.memberLoading=false;
        if(S.member) writeHint({role:'member', uid:u.uid, wid:S.member.workerId});
        if(!S.signingUp){ subscribe(); applyReadonly(); refreshStatus(); renderJoin(); bkRender(); }
        notifyPhase();
      });
    }else{
      S.admin=false; S.readonly=false; S.unitCode=null; S.pendingDir=null; S.memberLoading=false;
      if(unsub){ unsub(); unsub=null; }
      writeHint(null);
      try{ localStorage.removeItem(RECV_KEY); }catch(e){}
    }
    if(prevUid && (!u || u.uid!==prevUid) && window.onSyncAccountChange) window.onSyncAccountChange();
    applyReadonly();
    toggleLoginUI();
    refreshStatus();
    renderJoin();
    bkRender();
    notifyPhase();
  });

  /* ============================================================
     구성원 계정 — 부대 코드 가입 + 본인 선택
     directory/{부대코드}: 본인 선택용 명단(관리자가 업로드 때 갱신). 코드를 알아야 경로를 안다.
     members/{uid} + claims/{근무자id}: 한 batch로 만들어야 보안 규칙을 통과한다(근무자당 계정 1개).
     ============================================================ */
  function dirPayloadJson(){
    return JSON.stringify(DB.workers.filter(w=>w.active).map(w=>({id:w.id, name:w.name})));
  }
  function loadMember(u){
    S.memberErr=false;
    return fs.collection('members').doc(u.uid).get()
      .then(d=>{ if(d.exists){ S.member=d.data(); S.legacy=false; window.MY_WORKER=S.member.workerId||null; } })
      .catch(()=>{
        // 오프라인 등으로 본인 연결을 못 읽음 — 이 기기에서 같은 계정으로 연결했던 기록이 있으면 그대로 쓰고,
        // 없으면 '가입 필요'로 오판하지 않도록 오류 단계로 둔다
        const hint=readHint();
        if(hint && hint.role==='member' && hint.uid===u.uid){ S.member={workerId:hint.wid, provisional:true}; window.MY_WORKER=hint.wid; }
        else S.memberErr=true;
      });
  }
  function loadAdmin(){
    return fs.collection('secrets').doc('unit').get()
      .then(d=>{
        S.unitCode = d.exists ? (d.data().code||null) : null; renderAdmin();
        if(!S.unitCode) return;
        loadMembers();
        // 서버의 본인 선택 명단이 현재 근무자와 다르면 바로 맞춘다
        return fs.collection('directory').doc(S.unitCode).get().then(x=>{
          S.dirJson = x.exists ? (x.data().json||'') : '';
          const dj=dirPayloadJson();
          if(dj!==S.dirJson) return fs.collection('directory').doc(S.unitCode).set({json:dj, updatedAt:firebase.firestore.FieldValue.serverTimestamp()}).then(()=>{ S.dirJson=dj; });
        });
      })
      .catch(e=>{ qs('#syCodeNow').textContent='불러오기 실패 — 새 보안 규칙이 게시됐는지 확인하세요 ('+e.message+')'; });
  }
  function codeOk(c){ return /^[A-Za-z0-9가-힣_-]{8,40}$/.test(c); }
  function fetchDir(code){
    return fs.collection('directory').doc(code).get().then(d=> d.exists ? JSON.parse(d.data().json||'[]') : null);
  }

  /* 가입 = 계정 생성 → 부대 코드 확인(틀리면 방금 만든 계정 삭제) → 본인 선택.
     부대 명단은 로그인한 사용자만 읽을 수 있어(보안 규칙) 계정을 먼저 만든다. */
  function doSignup(em, pw, code){
    S.signingUp=true; notifyPhase();
    return auth.createUserWithEmailAndPassword(em,pw)
      .then(cred=> fetchDir(code).catch(()=>null).then(list=>{
        if(!list){
          return cred.user.delete().catch(()=>auth.signOut()).then(()=>{
            S.signingUp=false; notifyPhase();
            throw Object.assign(new Error('부대 코드가 올바르지 않습니다'), {code:'app/bad-unit-code'});
          });
        }
        S.signingUp=false; S.pendingDir={code, list};
        subscribe(); renderJoin(); toggleLoginUI(); notifyPhase();
        return list;
      }))
      .catch(e=>{ S.signingUp=false; notifyPhase(); throw e; });
  }
  function doCheckCode(code){
    return fetchDir(code).then(list=>{
      if(!list) throw Object.assign(new Error('부대 코드가 올바르지 않습니다'), {code:'app/bad-unit-code'});
      S.pendingDir={code, list}; renderJoin(); notifyPhase(); return list;
    });
  }
  function doClaim(wid){
    const d=S.pendingDir, u=S.user;
    if(!u||!d||!wid) return Promise.reject(Object.assign(new Error('본인 선택 전'),{code:'app/no-pending'}));
    const w=d.list.find(x=>x.id===wid);
    const batch=fs.batch();
    const mem={email:u.email||'', workerId:wid, workerName:w?w.name:'', code:d.code, createdAt:firebase.firestore.FieldValue.serverTimestamp()};
    batch.set(fs.collection('members').doc(u.uid), mem);
    batch.set(fs.collection('claims').doc(wid), {uid:u.uid, email:u.email||''});
    return batch.commit().then(()=>{
      S.member=mem; S.pendingDir=null; S.denied=false; S.legacy=false; window.MY_WORKER=wid;
      writeHint({role:'member', uid:u.uid, wid});
      renderJoin(); subscribe(); refreshStatus(); refreshAll(); notifyPhase();
    }).catch(e=>{ throw Object.assign(new Error(e.message), {code: e.code==='permission-denied' ? 'app/claim-denied' : (e.code||'app/claim-failed')}); });
  }
  qs('#sySignup').addEventListener('click',()=>{
    const em=(qs('#syEmail').value||'').trim(), pw=qs('#syPass').value, pw2=qs('#syPass2').value, code=(qs('#syJoinCode').value||'').trim();
    if(!em||!pw){ status('<div class="err">이메일과 비밀번호를 입력하세요.</div>'); return; }
    if(pw.length<6){ status('<div class="err">비밀번호는 6자 이상이어야 합니다.</div>'); return; }
    if(pw!==pw2){ status('<div class="err">비밀번호 확인이 일치하지 않습니다.</div>'); return; }
    if(!codeOk(code)){ status('<div class="err">부대 코드를 확인하세요.</div>'); return; }
    doSignup(em,pw,code).then(()=>status('<div class="ok">✓ 가입 완료 — 아래에서 본인을 선택하세요.</div>'))
      .catch(e=>status('<div class="err">가입 실패: '+esc(authMsg(e))+'</div>'));
  });
  /* 이미 계정은 있는데 등록 전인 경우: 부대 코드 → 명단 불러오기 */
  qs('#syCodeCheck').addEventListener('click',()=>{
    const code=(qs('#syCode').value||'').trim();
    if(!codeOk(code)){ status('<div class="err">부대 코드를 확인하세요.</div>'); return; }
    doCheckCode(code).catch(e=>status('<div class="err">'+esc(authMsg(e))+'</div>'));
  });
  qs('#syClaim').addEventListener('click',()=>{
    const wid=qs('#syWho').value, d=S.pendingDir;
    if(!wid||!d) return;
    const w=d.list.find(x=>x.id===wid);
    if(!confirm((w?w.name:'')+' — 본인이 맞습니까?\n선택 후에는 행보관만 바꿀 수 있습니다.')) return;
    doClaim(wid).catch(e=>status('<div class="err">'+esc(authMsg(e))+'</div>'));
  });
  function renderJoin(){
    const box=qs('#syJoin'); if(!box) return;
    const show = !!S.user && !S.admin && !S.member && !S.legacy;
    box.style.display = show?'':'none';
    if(!show) return;
    const d=S.pendingDir;
    qs('#syJoinStep1').style.display = d?'none':'';
    qs('#syJoinStep2').style.display = d?'':'none';
    if(d){
      const sel=qs('#syWho'); sel.innerHTML='';
      const o0=document.createElement('option'); o0.value=''; o0.textContent='— 본인을 선택하세요 —'; sel.appendChild(o0);
      d.list.slice().sort((a,b)=>a.name.localeCompare(b.name,'ko')).forEach(w=>{ const o=document.createElement('option'); o.value=w.id; o.textContent=w.name; sel.appendChild(o); });
    }
  }

  /* ---------- 관리자: 부대 코드 · 가입자 관리 ---------- */
  function renderAdmin(){
    qs('#syCodeNow').innerHTML = S.unitCode ? '현재 코드: <b>'+esc(S.unitCode)+'</b>' : '<span style="color:var(--warn)">아직 부대 코드가 없습니다 — 설정해야 구성원이 가입할 수 있습니다.</span>';
  }
  qs('#syCodeSave').addEventListener('click',()=>{
    const code=(qs('#syNewCode').value||'').trim();
    if(!codeOk(code)){ alert('부대 코드는 8~40자(한글·영문·숫자·-·_)로 정하세요. 짧으면 추측당하기 쉽습니다.'); return; }
    if(S.unitCode && !confirm('부대 코드를 바꿀까요?\n이미 가입한 구성원은 그대로 유지되고, 새로 가입하는 사람만 새 코드를 써야 합니다.')) return;
    const batch=fs.batch(), dj=dirPayloadJson();
    batch.set(fs.collection('secrets').doc('unit'), {code});
    batch.set(fs.collection('directory').doc(code), {json:dj, updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
    if(S.unitCode && S.unitCode!==code) batch.delete(fs.collection('directory').doc(S.unitCode));
    batch.commit().then(()=>{ S.unitCode=code; S.dirJson=dj; qs('#syNewCode').value=''; renderAdmin(); status('<div class="ok">✓ 부대 코드를 저장했습니다.</div>'); })
      .catch(e=>status('<div class="err">코드 저장 실패: '+esc(e.message)+' — 새 보안 규칙이 게시됐는지 확인하세요.</div>'));
  });
  function loadMembers(){
    const box=qs('#syMembers'); box.innerHTML='<span class="muted">불러오는 중…</span>';
    fs.collection('members').get().then(snap=>{
      box.innerHTML='';
      if(snap.empty){ box.innerHTML='<span class="muted">아직 가입한 구성원이 없습니다.</span>'; return; }
      const rows=[]; snap.forEach(d=>rows.push(Object.assign({uid:d.id}, d.data())));
      rows.sort((a,b)=>String(nameOf(a.workerId)).localeCompare(String(nameOf(b.workerId)),'ko'));
      rows.forEach(m=>box.appendChild(memberRow(m)));
    }).catch(e=>{ box.innerHTML='<span class="err">불러오기 실패: '+esc(e.message)+'</span>'; });
  }
  qs('#syMembersLoad').addEventListener('click', loadMembers);
  function memberRow(m){
    const row=document.createElement('div'); row.className='mrow';
    const known=DB.workers.some(w=>w.id===m.workerId);
    row.innerHTML='<div class="mw"><b>'+esc(known?nameOf(m.workerId):(m.workerName||'?')+' (명단에 없음)')+'</b><span>'+esc(m.email||'')+'</span></div>';
    const sel=document.createElement('select');
    DB.workers.filter(w=>w.active||w.id===m.workerId).forEach(w=>{ const o=document.createElement('option'); o.value=w.id; o.textContent=w.name; sel.appendChild(o); });
    sel.value=m.workerId;
    const chg=document.createElement('button'); chg.className='btn ghost sm'; chg.textContent='연결 변경';
    chg.addEventListener('click',()=>{
      const nw=sel.value; if(!nw||nw===m.workerId) return;
      fs.collection('claims').doc(nw).get().then(c=>{
        if(c.exists && c.data().uid!==m.uid){ alert(nameOf(nw)+'은(는) 이미 다른 계정('+(c.data().email||'')+')에 연결돼 있습니다. 먼저 그 계정을 해제하세요.'); return; }
        const b=fs.batch();
        b.delete(fs.collection('claims').doc(m.workerId));
        b.set(fs.collection('claims').doc(nw), {uid:m.uid, email:m.email||''});
        b.update(fs.collection('members').doc(m.uid), {workerId:nw, workerName:nameOf(nw)});
        return b.commit().then(loadMembers);
      }).catch(e=>alert('변경 실패: '+e.message));
    });
    const del=document.createElement('button'); del.className='btn danger sm'; del.textContent='해제';
    del.addEventListener('click',()=>{
      if(!confirm((m.email||'')+' 계정의 연결을 해제할까요?\n해제하면 근무표를 볼 수 없고, 부대 코드로 다시 등록해야 합니다.')) return;
      const b=fs.batch();
      b.delete(fs.collection('members').doc(m.uid));
      b.delete(fs.collection('claims').doc(m.workerId));
      b.commit().then(loadMembers).catch(e=>alert('해제 실패: '+e.message));
    });
    const act=document.createElement('div'); act.className='ma';
    act.appendChild(sel); act.appendChild(chg); act.appendChild(del);
    row.appendChild(act);
    return row;
  }

  /* ============================================================
     서버 백업 (관리자) — 근무표를 생성할 때마다(자동) 또는 [지금 서버에 백업](수동)으로 전체 데이터(JSON 내보내기와 같은 내용)를
     backups/{id}에 올리고 최근 BK_KEEP개만 남긴다. 문서 한도(1MB)를 넘지 않게 본문은
     backups/{id}/parts/{n}에 나눠 담는다. roster와 따로 두는 이유: 구성원 화면은 roster 전체를
     실시간 수신하므로 거기에 두면 백업까지 매번 내려받게 된다.
     ============================================================ */
  const BK_KEEP=10, BK_CHUNK=250000;   // 한글 3바이트 기준으로도 1MB 미만
  const bkCol=()=>fs.collection('backups');
  function bkTime(d){ const p=n=>String(n).padStart(2,'0');
    return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }
  function bkErr(e){ return /permission|insufficient/i.test(e&&e.message||'') ? '권한 없음 — FIREBASE_SETUP.md 4번 보안 규칙(backups 포함)을 다시 게시하세요' : (e&&e.message||String(e)); }
  function bkDelete(id, parts){
    const b=fs.batch();
    for(let i=0;i<(parts||0);i++) b.delete(bkCol().doc(id).collection('parts').doc(String(i)));
    b.delete(bkCol().doc(id));
    return b.commit();
  }
  /* 최근 BK_KEEP개를 넘는 오래된 백업 삭제 */
  function bkPrune(){
    return bkCol().orderBy('savedAtMs','desc').get().then(snap=>{
      const old=snap.docs.slice(BK_KEEP);
      return Promise.all(old.map(d=>bkDelete(d.id, d.data().parts)));
    });
  }
  function bkCreate(reason){
    if(!S.on || !S.admin) return Promise.resolve({ok:false, skipped:true});
    const now=new Date(), json=JSON.stringify(DB);
    const id='b'+now.getTime();
    const chunks=[]; for(let i=0;i<json.length;i+=BK_CHUNK) chunks.push(json.slice(i,i+BK_CHUNK));
    const ref=bkCol().doc(id);
    // 조각을 먼저 쓰고 목록 문서를 마지막에 쓴다 → 목록에 보이는 백업은 항상 완전하다
    const writes=[];
    for(let i=0;i<chunks.length;i+=400){
      const b=fs.batch();
      chunks.slice(i,i+400).forEach((c,j)=> b.set(ref.collection('parts').doc(String(i+j)), {json:c}));
      writes.push(b.commit());
    }
    return Promise.all(writes)
      .then(()=>ref.set({savedAt:bkTime(now), savedAtMs:now.getTime(), reason:reason||'', by:S.user?S.user.email:'',
        parts:chunks.length, size:json.length, workers:DB.workers.length, days:Object.keys(DB.schedules).length,
        createdAt:firebase.firestore.FieldValue.serverTimestamp()}))
      .then(bkPrune)
      .then(()=>{ if(qs('#bkList') && qs('#bkList').dataset.shown) bkRender(); return {ok:true, at:bkTime(now)}; })
      .catch(e=>({ok:false, err:bkErr(e)}));
  }
  function bkLoad(id, parts){
    const ps=[]; for(let i=0;i<parts;i++) ps.push(bkCol().doc(id).collection('parts').doc(String(i)).get());
    return Promise.all(ps).then(ds=>{
      if(ds.some(d=>!d.exists)) throw new Error('백업 조각이 빠져 있습니다');
      return JSON.parse(ds.map(d=>d.data().json).join(''));
    });
  }
  function bkRender(){
    const box=qs('#bkList'); if(!box) return;
    const panel=qs('#bkPanel');
    if(!S.on || !S.admin){ if(panel) panel.style.display='none'; return; }
    if(panel) panel.style.display='';
    const view=qs('#backup'); if(view && !view.classList.contains('on')) return;   // 화면을 열 때 불러온다
    box.dataset.shown='1';
    box.innerHTML='<div class="muted">불러오는 중…</div>';
    bkCol().orderBy('savedAtMs','desc').limit(BK_KEEP).get().then(snap=>{
      box.innerHTML='';
      if(snap.empty){ box.innerHTML='<div class="muted">아직 서버 백업이 없습니다. 근무표를 생성하면 자동으로 만들어집니다.</div>'; return; }
      snap.docs.forEach((d,i)=>{
        const m=d.data();
        const row=document.createElement('div'); row.className='bkrow';
        row.innerHTML='<div class="bd"><div class="tm">'+esc(m.savedAt||'')+(i===0?' <span class="pill">최신</span>':'')+'</div>'
          +'<div class="rs">'+esc(m.reason||'')+'</div>'
          +'<div class="mt">근무자 '+(m.workers||0)+'명 · 근무표 '+(m.days||0)+'일 · '+Math.round((m.size||0)/1024)+'KB'+(m.by?' · '+esc(m.by):'')+'</div></div>';
        const act=document.createElement('div'); act.className='ma';
        const dl=document.createElement('button'); dl.className='btn ghost sm'; dl.textContent='내려받기';
        dl.addEventListener('click',()=>bkLoad(d.id, m.parts).then(obj=>{
          downloadBlob('cctv_server_backup_'+String(m.savedAt||d.id).replace(/[: ]/g,'-')+'.json', JSON.stringify(obj,null,2), 'application/json');
        }).catch(e=>alert('내려받기 실패: '+bkErr(e))));
        const rs=document.createElement('button'); rs.className='btn danger sm'; rs.textContent='이 시점으로 복원';
        rs.addEventListener('click',()=>bkLoad(d.id, m.parts).then(obj=>{
          const next=migrate(obj);
          if(!confirm(m.savedAt+' 백업으로 되돌릴까요?\n\n지금: 근무자 '+DB.workers.length+'명 · 근무표 '+Object.keys(DB.schedules).length+'일\n백업: 근무자 '+next.workers.length+'명 · 근무표 '+Object.keys(next.schedules).length+'일\n\n지금 상태도 먼저 서버에 백업해 둡니다.')) return;
          return bkCreate('복원 직전 자동 백업').then(()=>{
            DB=next; invalidateStats(); save(); refreshAll();
            alert('✓ '+m.savedAt+' 백업으로 복원했습니다.');
          });
        }).catch(e=>alert('복원 실패: '+bkErr(e))));
        act.appendChild(dl); act.appendChild(rs); row.appendChild(act);
        box.appendChild(row);
      });
    }).catch(e=>{ box.innerHTML='<div class="err">백업 목록을 불러오지 못했습니다: '+esc(bkErr(e))+'</div>'; });
  }
  /* 수동 백업 */
  qs('#bkNow').addEventListener('click',()=>{
    const b=qs('#bkNow'), st=qs('#bkNowSt');
    b.disabled=true; st.textContent='백업 중…';
    bkCreate('수동 백업').then(r=>{
      b.disabled=false;
      st.textContent = r.ok ? '✓ 백업 완료 · '+r.at : r.skipped ? '관리자로 로그인해야 합니다' : '⚠ 실패: '+r.err;
      if(r.ok) bkRender();
    });
  });
  window.SYNC_BACKUP=bkCreate;
  window.SYNC_BACKUP_LIST=bkRender;

  /* ============================================================
     구성원 API — 내 근무 화면(index.html)의 로그인·가입·개인 확인 상태가 쓴다.
     개인 확인 상태는 personal/{uid}(본인만 읽고 쓰기)에 따로 저장한다 — 근무표(roster)와 save()는 건드리지 않는다.
     ============================================================ */
  function withTimeout(p, ms){
    return new Promise((ok,no)=>{ const t=setTimeout(()=>no(Object.assign(new Error('timeout'),{code:'app/timeout'})), ms);
      p.then(v=>{ clearTimeout(t); ok(v); }, e=>{ clearTimeout(t); no(e); }); });
  }
  function personalRef(){ return fs.collection('personal').doc(S.user.uid); }
  window.MEMBER_API={
    phase,
    info(){ return {phase:phase(), uid:S.user?S.user.uid:null, email:S.user?(S.user.email||''):'', wid:S.member?S.member.workerId:null,
      live:S.live && navigator.onLine!==false, liveErr:S.liveErr, lastRecv:S.lastRecv||storedRecv(),
      pendingList:S.pendingDir?S.pendingDir.list.slice():null, legacy:S.legacy}; },
    login(em,pw){ return auth.signInWithEmailAndPassword(em,pw); },
    signup:doSignup, checkCode:doCheckCode, claim:doClaim, codeOk,
    reset(em){ return auth.sendPasswordResetEmail(em); },
    logout(){ return auth.signOut(); },
    retry(){ const u=S.user; if(!u) return Promise.resolve(); S.memberLoading=true; notifyPhase();
      return loadMember(u).then(()=>{ if(S.user!==u) return; S.memberLoading=false; if(S.member&&!S.member.provisional) writeHint({role:'member', uid:u.uid, wid:S.member.workerId}); subscribe(); applyReadonly(); notifyPhase(); }); },
    msg:authMsg,
    /* 개인 확인 상태 — 등록된 구성원만(공용·미등록 계정은 index가 이 기기 저장으로 처리) */
    canStore(){ return !!(S.user && S.member); },
    personalLoad(){
      if(!S.user||!S.member) return Promise.reject(Object.assign(new Error('not member'),{code:'app/not-member'}));
      return withTimeout(personalRef().get(), 8000).then(d=>{
        if(!d.exists) return null;
        const x=d.data(); let base=null; try{ base=JSON.parse(x.base||'null'); }catch(e){}
        return {wid:x.wid, base};
      });
    },
    personalSave(wid, base){
      if(!S.user||!S.member) return Promise.reject(Object.assign(new Error('not member'),{code:'app/not-member'}));
      return withTimeout(personalRef().set({wid, base:JSON.stringify(base), savedAt:firebase.firestore.FieldValue.serverTimestamp()}), 8000);
    }
  };
  /* 인증·가입 오류를 다음 행동이 보이는 한국어로 */
  function authMsg(e){
    const c=(e&&e.code)||'', m=(e&&e.message)||'';
    const k=c||(/auth\/[a-z-]+/.exec(m)||[''])[0];
    const T={
      'auth/invalid-email':'이메일 형식이 올바르지 않습니다. 예: name@example.com',
      'auth/missing-email':'이메일을 입력하세요.',
      'auth/missing-password':'비밀번호를 입력하세요.',
      'auth/user-not-found':'이메일 또는 비밀번호가 맞지 않습니다. 다시 입력하거나 [비밀번호를 잊었어요]로 재설정하세요.',
      'auth/wrong-password':'이메일 또는 비밀번호가 맞지 않습니다. 다시 입력하거나 [비밀번호를 잊었어요]로 재설정하세요.',
      'auth/invalid-credential':'이메일 또는 비밀번호가 맞지 않습니다. 다시 입력하거나 [비밀번호를 잊었어요]로 재설정하세요.',
      'auth/invalid-login-credentials':'이메일 또는 비밀번호가 맞지 않습니다. 다시 입력하거나 [비밀번호를 잊었어요]로 재설정하세요.',
      'auth/too-many-requests':'시도가 너무 많아 잠시 막혔습니다. 몇 분 뒤 다시 시도하거나 비밀번호를 재설정하세요.',
      'auth/network-request-failed':'인터넷에 연결되지 않았습니다. 연결을 확인한 뒤 다시 시도하세요.',
      'auth/email-already-in-use':'이미 가입된 이메일입니다. [로그인]에서 이 이메일로 로그인하세요.',
      'auth/weak-password':'비밀번호는 6자 이상으로 정하세요.',
      'auth/user-disabled':'사용이 중지된 계정입니다. 행보관에게 문의하세요.',
      'auth/operation-not-allowed':'이 앱에서 이메일 로그인이 꺼져 있습니다. 행보관에게 알려 주세요.',
      'app/bad-unit-code':'부대 코드가 맞지 않습니다. 행보관에게 받은 코드를 다시 확인하세요. (방금 만든 계정은 지웠으니 다시 가입하면 됩니다)',
      'app/claim-denied':'이미 다른 계정이 이 이름을 선택했거나 부대 코드가 바뀌었습니다. 행보관에게 문의하세요.',
      'app/timeout':'서버 응답이 늦습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요.',
      'permission-denied':'권한이 없습니다. 행보관에게 보안 규칙 적용 여부를 확인해 달라고 하세요.',
      'unavailable':'서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.'
    };
    return T[k] || ('문제가 생겼습니다'+(k?' ('+k+')':'')+'. 잠시 뒤 다시 시도하세요.');
  }
  notifyPhase();
})();
