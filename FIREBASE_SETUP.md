# 서버 동기화 설정 가이드 (Firebase)

행보관(관리자)만 수정하고, 구성원은 실시간 열람만 하도록 만드는 설정입니다.
전부 무료이고(스파크 요금제), 한 번만 설정하면 됩니다. 소요 시간 약 10분.

## 동작 방식

- 관리자가 근무표를 수정하면 1.5초 뒤 자동으로 서버(Firestore)에 업로드됩니다.
- 데이터는 `roster/meta`(근무자·설정 등 공통)와 `roster/m-YYYY-MM`(월별 근무표) 문서로
  나뉘어 저장되며, 저장 시 바뀐 문서만 업로드합니다.
- 구버전(단일 `roster/main` 문서) 서버는 관리자가 접속하면 자동으로 새 형식으로
  변환되고 `main` 문서는 삭제됩니다.
- 관리자 접속 시 서버와 이 기기의 데이터가 다르면 **마지막 수정시각이 더 최신인 쪽을
  자동 반영**합니다(확인창 없음). 어느 쪽을 썼는지는 동기화 상태줄에 표시됩니다.
  기기 시계가 크게 틀어져 있으면 판정이 어긋날 수 있으니 자동 시간 설정을 권장합니다.
- 구성원은 **각자 계정**으로 가입합니다. 가입할 때 행보관이 정한 **부대 코드**를 입력해야 하고,
  코드가 맞으면 근무자 명단에서 본인을 고릅니다(한 근무자당 계정 1개). 이후 **읽기 전용 화면**
  (생성·관리 탭 숨김, 편집 비활성)으로 실시간 갱신을 받고, [내 근무] 탭과 근무표에서 본인이
  자동으로 강조됩니다.
- 부대 코드 검증과 "근무자당 계정 1개"는 앱이 아니라 **보안 규칙**이 검사합니다. 코드는
  `directory/{부대코드}` 문서의 이름 자체라, 코드를 모르면 본인 선택 명단도 볼 수 없습니다.
- 로그인하지 않거나 오프라인이면 기존처럼 그 브라우저의 localStorage로만 동작합니다.
- 권한은 화면 숨김이 아니라 **서버의 보안 규칙**으로 강제되므로, 구성원이 임의로
  데이터를 고칠 수 없습니다.

## 1. Firebase 프로젝트 만들기

1. https://console.firebase.google.com 접속 (Google 계정 필요)
2. **프로젝트 추가** → 이름 아무거나(예: `cctv-roster`) → 애널리틱스는 꺼도 됨 → 만들기

## 2. 로그인(Authentication) 설정

1. 왼쪽 메뉴 **빌드 → Authentication → 시작하기**
2. **이메일/비밀번호** 선택 → 사용 설정 → 저장
3. **Users 탭 → 사용자 추가**로 관리자 계정 생성: 행보관용 (예: `admin@unit.local` / 강한 비밀번호)
   - 구성원은 앱의 [회원가입]으로 각자 만듭니다(부대 코드 필요). 콘솔에서 따로 만들 필요 없습니다.
   - 비밀번호를 잊었을 때 재설정 메일을 받으려면 실제로 수신 가능한 이메일로 가입해야 합니다.
   - 예전에 쓰던 **공용 열람 계정**(예: `viewer@unit.local`)은 전환 기간 동안만 아래 규칙의
     `isLegacyViewer()` 목록에 넣어 두세요.

## 3. Firestore 데이터베이스 만들기

1. **빌드 → Firestore Database → 데이터베이스 만들기**
2. 위치는 `asia-northeast3 (서울)` 권장 → **프로덕션 모드**로 시작

## 4. 보안 규칙 적용 (중요!)

Firestore의 **규칙(Rules)** 탭에 아래를 붙여넣고, 두 곳을 바꾼 뒤 **게시**하세요.
- `admin@unit.local` → 실제 관리자(행보관) 이메일
- `viewer@unit.local` → 예전 공용 열람 계정 이메일 (없으면 `[]`로 비우기)

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

이 규칙이 곧 권한 체계입니다. 규칙을 적용하지 않으면(테스트 모드 등)
인터넷의 아무나 데이터를 읽고 쓸 수 있으니 반드시 적용하세요.

## 5. 웹 앱 설정값 가져오기

1. **프로젝트 개요 옆 ⚙ → 프로젝트 설정 → 내 앱 → 웹(`</>`) 앱 추가** (이름 아무거나)
2. 표시되는 `firebaseConfig = { apiKey: ..., projectId: ..., ... }` 부분을 복사

## 6. 앱에 연결 — 두 가지 방법 중 하나

**방법 A (권장): 설정 파일 배포** — 구성원이 아무 입력 없이 쓸 수 있음

1. `firebase-config.sample.js`를 `firebase-config.js`로 복사
2. 복사한 설정값과 관리자 이메일을 채워넣고 저장소에 커밋/배포

**방법 B: 브라우저에서 직접 입력**

1. 앱의 **[기본 설정] → 서버 동기화 → 연결 설정**에 설정값 붙여넣기
2. 관리자 이메일 입력 → **연결 설정 저장** (기기마다 한 번씩 해야 함)

> 웹 API 키는 공개되어도 됩니다. 데이터 접근은 4번의 보안 규칙이 막습니다.

## 7. 사용

- **행보관**: [더보기 › 서버 동기화]에서 관리자 계정으로 로그인.
  이후 수정할 때마다 자동 업로드됩니다 (상태에 "관리자 모드" 표시).
  - 처음 한 번 같은 화면의 **부대 코드**를 정해 저장하세요(8자 이상). 이 코드를 구성원에게 알려줍니다.
  - **가입자 관리**에서 잘못 고른 사람은 [연결 변경], 전역·전출자는 [해제]합니다.
    로그인 계정 자체의 삭제는 Firebase 콘솔 → Authentication에서 합니다.
- **구성원**: 같은 화면에서 [회원가입] → 이메일·비밀번호·부대 코드 입력 → 본인 선택.
  이후 화면 상단에 "열람 전용" 배지가 뜨고 실시간으로 갱신되며, [내 근무] 탭에서
  다가오는 근무와 부대 평균 대비 내 배정률을 볼 수 있습니다.
- **전환 순서**: ① 새 규칙 게시(공용 계정은 `isLegacyViewer`에 남겨 둠) → ② 행보관이 부대 코드
  저장 → ③ 구성원 가입 → ④ 모두 가입하면 `isLegacyViewer` 목록을 `[]`로 비우고 다시 게시.
- 로그인 상태는 브라우저에 유지되므로 매번 로그인할 필요는 없습니다.

## 호스팅 (구성원이 접속할 주소)

저장소를 GitHub Pages로 공개하면 됩니다:
**GitHub 저장소 → Settings → Pages → Branch: main → Save** →
몇 분 뒤 `https://<계정명>.github.io/cctv/` 로 접속 가능.

저장소에는 코드만 있고 근무 데이터는 Firestore(로그인 필요)에만 있으므로
공개해도 인원 정보가 노출되지 않습니다.

## 문제 해결

| 증상 | 원인/해결 |
|---|---|
| "업로드 실패: Missing or insufficient permissions" | 보안 규칙의 관리자 이메일과 로그인 계정이 다름. 규칙·[연결 설정]의 이메일 확인 |
| "실시간 수신 오류" | 규칙 미적용 또는 로그아웃 상태. 4번 규칙 게시 확인 |
| 로그인 실패 (auth/...) | Authentication에 계정이 없거나 비밀번호 틀림 |
| 가입 시 "부대 코드가 올바르지 않습니다" | 코드 오타 또는 행보관이 코드를 바꿈. [더보기 › 서버 동기화]의 현재 코드 확인 |
| 본인 선택 시 "선택 실패" | 그 근무자에 이미 다른 계정이 연결됨. 행보관이 가입자 관리에서 해제 후 다시 선택 |
| 관리자 화면에 "부대 코드 불러오기 실패" | 새 보안 규칙(4번)이 아직 게시되지 않음 |
| 생성 후 "서버 백업 실패: 권한 없음" | 4번 규칙에 `backups` 부분이 없음(v6.8.0 이전 규칙). 4번 규칙을 다시 붙여넣고 게시 |
| 가입자 관리 [연결 변경]이 "Missing or insufficient permissions" | 예전 규칙(claims 생성에 관리자 경로 없음)을 쓰는 중. 4번 규칙을 다시 붙여넣고 게시 |
| 구성원인데 편집 화면이 보임 | [연결 설정]의 관리자 이메일이 비어 있거나 본인 이메일로 되어 있음 |
| "문서 …가 900KB를 넘었습니다" 경고 | 월별 분할 저장이라 정상 사용에서는 발생하지 않습니다. 발생 시 JSON 백업 후 오래된 근무표 삭제 (Firestore 문서 한도 1MB) |
