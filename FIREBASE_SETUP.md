# 서버 동기화 설정 가이드 (Firebase)

관리자만 근무표를 수정하고, 구성원은 실시간 열람만 하도록 설정합니다.
무료(Spark 요금제)이며, 최초 1회만 설정하면 됩니다. 약 10분 소요됩니다.

## 동작 방식

- 관리자가 근무표를 수정하면 1.5초 뒤 서버(Firestore)에 자동 업로드됩니다.
- 데이터는 공통 설정 문서(`roster/meta`)와 월별 근무표 문서(`roster/m-YYYY-MM`)로 분할 저장됩니다. 변경된 문서만 업로드됩니다.
- 구버전 단일 문서(`roster/main`)는 관리자 접속 시 신규 분할 형식으로 자동 변환된 후 삭제됩니다.
- 관리자 접속 시 서버와 기기의 데이터가 다르면 **최종 수정 시각이 더 최신인 쪽을 자동 반영**합니다(확인창 없음). 반영 결과는 동기화 상태줄에 표시됩니다. 기기 시각이 어긋나면 판정 오류가 발생할 수 있으므로 기기의 자동 시간 설정을 사용하십시오.
- 구성원은 **개인 계정**으로 가입합니다. 가입 시 관리자가 발급한 **부대 코드**를 입력해야 하며, 코드가 확인되면 근무자 명단에서 본인을 지정합니다(1인 1계정). 가입 후에는 **읽기 전용 모드**(생성·관리 탭 숨김, 편집 불가)로 실시간 동기화되며, [내 근무] 탭과 근무표에서 본인 근무가 자동 강조됩니다.
- 부대 코드 검증과 1인 1계정 제한은 클라이언트가 아닌 **Firestore 보안 규칙**으로 서버에서 강제합니다. 코드는 `directory/{부대코드}` 문서명이므로 코드를 입력하지 않으면 명단 조회가 불가능합니다.
- 비로그인 또는 오프라인 상태에서는 브라우저의 로컬 저장소(localStorage)로만 동작합니다.
- 모든 권한은 UI 제어가 아닌 **서버 보안 규칙**으로 제어되므로, 구성원이 임의로 데이터를 수정할 수 없습니다.

## 1. Firebase 프로젝트 만들기

1. https://console.firebase.google.com 접속 (Google 계정 필요)
2. **프로젝트 추가** → 프로젝트명 입력(예: `cctv-roster`) → 애널리틱스 비활성화 가능 → 프로젝트 생성

## 2. 로그인(Authentication) 설정

1. 좌측 메뉴 **빌드 → Authentication → 시작하기**
2. **이메일/비밀번호** 선택 → 사용 설정 켜기 → 저장
3. **Users 탭 → 사용자 추가**에서 관리자 계정 생성: (예: `admin@unit.local` / 보안 강도 높은 비밀번호)
   - 구성원은 앱의 [회원가입] 화면에서 부대 코드를 입력하여 직접 가입합니다. 콘솔에서 수동 생성할 필요 없습니다.
   - 비밀번호 재설정 메일을 수신하려면 실제 사용 중인 유효한 이메일로 가입해야 합니다.
   - 기존 **공용 열람 계정**(예: `viewer@unit.local`)을 사용 중이었다면 전환 기간 동안만 보안 규칙의 `isLegacyViewer()` 목록에 등록하십시오.

## 3. Firestore 데이터베이스 만들기

1. **빌드 → Firestore Database → 데이터베이스 만들기**
2. 위치는 `asia-northeast3 (서울)` 권장 → **프로덕션 모드** 선택 후 생성

## 4. 보안 규칙 적용 (필수)

Firestore **규칙(Rules)** 탭에 아래 규칙을 붙여넣고, 두 항목을 수정한 후 **게시**하십시오.
- `admin@unit.local` → 실제 관리자 이메일
- `viewer@unit.local` → 기존 공용 열람 계정 이메일 (없으면 `[]`로 설정)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    function isAdmin() { return signedIn() && request.auth.token.email == 'admin@unit.local'; }
    function isMember() { return signedIn() && exists(/databases/$(database)/documents/members/$(request.auth.uid)); }
    // 전환 기간용 공용 열람 계정 — 구성원이 모두 가입하면 목록을 비우세요: in []
    function isLegacyViewer() { return signedIn() && request.auth.token.email in ['viewer@unit.local']; }

    // 근무표 데이터: 읽기 = 관리자·등록된 구성원(·전환 기간 공용 계정), 쓰기 = 관리자
    match /roster/{doc} {
      allow read: if isAdmin() || isMember() || isLegacyViewer();
      allow write: if isAdmin();
    }
    // 현재 부대 코드 (관리자만)
    match /secrets/{doc} {
      allow read, write: if isAdmin();
    }
    // 본인 선택용 명단 — 문서 이름이 부대 코드. 코드를 아는 로그인 사용자만 한 건 조회 가능
    match /directory/{code} {
      allow get: if signedIn();
      allow list, write: if isAdmin();
    }
    // 구성원 등록: 부대 코드가 맞고, 같은 batch로 그 근무자의 claim을 함께 만들어야 통과
    match /members/{uid} {
      allow get: if isAdmin() || (signedIn() && request.auth.uid == uid);
      allow list: if isAdmin();
      allow create: if signedIn() && request.auth.uid == uid
        && request.resource.data.keys().hasOnly(['email', 'workerId', 'workerName', 'code', 'createdAt'])
        && request.resource.data.workerId is string
        && request.resource.data.code is string
        && exists(/databases/$(database)/documents/directory/$(request.resource.data.code))
        && getAfter(/databases/$(database)/documents/claims/$(request.resource.data.workerId)).data.uid == uid;
      allow update, delete: if isAdmin();
    }
    // 근무자당 계정 1개: claims/{근무자id}가 이미 있으면 새로 만들 수 없다
    match /claims/{workerId} {
      allow get: if isAdmin() || (signedIn() && resource.data.uid == request.auth.uid);
      allow list: if isAdmin();
      // 관리자는 [연결 변경]에서 다른 사람의 uid로 새 claim을 만든다 → 관리자 경로가 따로 필요
      allow create: if isAdmin() || (signedIn() && request.resource.data.uid == request.auth.uid
        && getAfter(/databases/$(database)/documents/members/$(request.auth.uid)).data.workerId == workerId);
      allow update, delete: if isAdmin();
    }
    // 구성원 개인 확인 상태(내 근무의 '지난 확인 이후 변경' 기준) — 본인만 읽고 쓴다.
    // 본인 연결(members)의 근무자와 같은 wid만, 정해진 필드만 허용. 근무표(roster) 쓰기 권한과는 무관
    match /personal/{uid} {
      allow get: if signedIn() && request.auth.uid == uid;
      allow create, update: if signedIn() && request.auth.uid == uid
        && request.resource.data.keys().hasOnly(['wid', 'base', 'savedAt'])
        && request.resource.data.wid is string
        && request.resource.data.base is string && request.resource.data.base.size() <= 20000
        && request.resource.data.savedAt == request.time
        && get(/databases/$(database)/documents/members/$(uid)).data.workerId == request.resource.data.wid;
      allow delete: if signedIn() && request.auth.uid == uid;
    }
    // 당직사관·당직사령 날짜별 기록 — 구성원이 명단에서 골라 기록(관리자도 가능), 공용 열람 계정은 보기만.
    // 문서 이름 = 날짜, 정해진 필드만, 기록자(by)는 본인 uid. 근무표(roster)와 별개 경로
    match /officerLog/{date} {
      allow read: if isAdmin() || isMember() || isLegacyViewer();
      allow create, update: if (isAdmin() || isMember())
        && date.matches('^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
        && request.resource.data.keys().hasOnly(['date', 'sagwanId', 'sagwanName', 'saryeongId', 'saryeongName', 'by', 'byName', 'at'])
        && request.resource.data.date == date
        && request.resource.data.by == request.auth.uid
        && request.resource.data.at == request.time
        && request.resource.data.byName is string && request.resource.data.byName.size() <= 30
        && (!('sagwanName' in request.resource.data) || (request.resource.data.sagwanName is string && request.resource.data.sagwanName.size() <= 30))
        && (!('saryeongName' in request.resource.data) || (request.resource.data.saryeongName is string && request.resource.data.saryeongName.size() <= 30));
      allow delete: if isAdmin();
    }
    // 서버 백업(최근 10회) — 관리자만. 본문은 parts 하위 문서에 나눠 저장
    match /backups/{id} {
      allow read, write: if isAdmin();
      match /parts/{n} {
        allow read, write: if isAdmin();
      }
    }
    // 그 외 경로는 전부 차단
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

권한은 이 보안 규칙에 따라 제어됩니다. 규칙을 적용하지 않으면(테스트 모드 등) 외부에서 데이터를 임의로 열람하거나 변조할 수 있으므로 반드시 게시하십시오.

## 5. 웹 앱 설정값 복사

1. **프로젝트 개요 ⚙ 아이콘 → 프로젝트 설정 → 내 앱 → 웹(`</>`) 앱 추가** (앱 닉네임 입력)
2. 화면에 표시되는 `firebaseConfig = { apiKey: ..., projectId: ..., ... }` 객체 복사

## 6. 앱 연결 (두 가지 방법 중 선택)

**방법 A (권장): 설정 파일 배포** — 구성원이 설정을 입력할 필요 없음

1. `firebase-config.sample.js`를 복사하여 `firebase-config.js` 생성
2. 복사한 Firebase 설정값과 관리자 이메일을 입력한 후 저장소에 커밋/배포

**방법 B: 브라우저 직접 입력**

1. 앱의 **[더보기 › 서버 동기화] → 연결 설정**에 설정값 붙여넣기
2. 관리자 이메일 입력 → **연결 설정 저장** 클릭 (기기별 최초 1회 수행)

> 웹 API 키는 브라우저 식별용 식별자이므로 공개되어도 무방합니다. 데이터 접근은 4번 보안 규칙이 통제합니다.

## 7. 사용 방법

- **관리자**: [더보기 › 서버 동기화]에서 관리자 계정으로 로그인합니다.
  수정 사항은 저장 시 서버에 자동 업로드됩니다 (상태줄에 "관리자 모드" 표시).
  - 최초 1회 동일 화면에서 **부대 코드**를 설정하십시오 (8자 이상). 설정한 코드를 부대 구성원에게 공유합니다.
  - **가입자 관리**에서 명단을 확인하고, 계정 연결 오류 인원은 [연결 변경], 전역·전출자는 [해제] 처리합니다.
    계정 자체를 삭제하려면 Firebase 콘솔 → Authentication에서 수행합니다.
- **구성원**: 앱 하단 **[내 근무]** 탭 → [처음이에요 · 가입] 선택: ① 이메일·비밀번호 입력 → ② 부대 코드 입력 → ③ 본인 이름 선택.
  가입 후에는 동일 화면에서 로그인합니다 (비밀번호 표시 및 재설정 메일 지원).
  로그인 상태가 유지되므로 이후 접속 시 즉시 내 근무 화면(다음 근무, 오늘 근무, 변경 내역, 주간 일정)으로 진입합니다.
  근무 확인 상태('확인했어요')는 `personal/{uid}` 경로에 본인 계정으로만 저장됩니다 (4번 규칙).
- **신규 전환 절차**: ① 신규 보안 규칙 게시 (공용 계정 사용 시 `isLegacyViewer`에 유지) → ② 관리자가 부대 코드 설정 → ③ 구성원 개별 가입 → ④ 전원 가입 완료 시 `isLegacyViewer` 목록을 `[]`로 비우고 규칙 재게시.
- 로그인 세션은 브라우저에 유지되므로 매 접속마다 로그인할 필요 없습니다.

## 호스팅 (구성원 접속 주소)

저장소를 GitHub Pages로 배포할 수 있습니다:
**GitHub 저장소 → Settings → Pages → Branch: main 선택 → Save**
배포 완료 후 `https://<계정명>.github.io/cctv/` 주소로 접속 가능합니다.

저장소에는 정적 소스 코드만 포함되며, 근무 데이터는 Firestore(인증 필요)에만 저장되므로 공개 저장소여도 부대 인원 정보가 노출되지 않습니다.

## 문제 해결

| 증상 | 원인 및 해결 방법 |
|---|---|
| "업로드 실패: Missing or insufficient permissions" | 보안 규칙의 관리자 이메일과 로그인 계정 불일치. 보안 규칙 및 [연결 설정]의 이메일 확인 |
| "실시간 수신 오류" | 보안 규칙 미적용 또는 로그아웃 상태. 4번 규칙 게시 여부 확인 |
| 로그인 실패 (auth/...) | Authentication에 계정이 없거나 비밀번호 불일치 |
| 가입 시 "부대 코드가 올바르지 않습니다" | 부대 코드 오타 또는 관리자의 코드 변경. [더보기 › 서버 동기화]에서 현재 코드 확인 |
| 본인 선택 시 "선택 실패" | 해당 근무자에 이미 다른 계정 연결됨. 관리자가 가입자 관리에서 기존 연결 해제 후 재시도 |
| 관리자 화면에 "부대 코드 불러오기 실패" | 신규 보안 규칙(4번) 미게시 상태. 규칙 재확인 및 게시 |
| 당직사관·당직사령 기록 시 "권한이 없습니다" | 4번 규칙에 `officerLog` 누락 (v7.1.0 이전 규칙). 4번 규칙 전체를 다시 복사하여 게시 |
| 내 근무에서 [확인했어요] 클릭 시 "권한이 없습니다" | 4번 규칙에 `personal` 누락 (v7.0.0 이전 규칙). 4번 규칙 전체를 다시 복사하여 게시 |
| 생성 후 "서버 백업 실패: 권한 없음" | 4번 규칙에 `backups` 누락 (v6.8.0 이전 규칙). 4번 규칙 전체를 다시 복사하여 게시 |
| 가입자 관리 [연결 변경] 시 "Missing or insufficient permissions" | 구버전 규칙 사용 중 (claims 생성 권한 경로 누락). 4번 규칙 전체를 다시 복사하여 게시 |
| 구성원 계정인데 관리자 편집 화면이 노출됨 | [연결 설정]의 관리자 이메일이 비어 있거나 해당 구성원 이메일로 등록됨 |
| "문서 …가 900KB를 넘었습니다" 경고 | 월별 분할 저장 구조이므로 일반적인 사용 환경에서는 발생하지 않음. 발생 시 [기본 설정]에서 JSON 백업 후 오래된 근무표 삭제 (Firestore 문서 용량 한도 1MB) |
