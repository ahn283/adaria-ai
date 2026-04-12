# Social Platform Credential Setup Guide

각 소셜 플랫폼별 API 자격증명 발급 절차. `adaria-ai init social`에서 입력할 값을 얻는 방법.

---

## Twitter / X

### 필요한 값

| 항목 | 설명 |
|------|------|
| API Key | Consumer Key |
| API Key Secret | Consumer Secret |
| Access Token | OAuth 1.0a user token |
| Access Token Secret | OAuth 1.0a user secret |

### 발급 절차

1. https://developer.x.com 접속 → 앱 선택 (또는 새로 생성)
2. **Settings** 탭 → **User authentication settings** → **Set up**
   - App permissions: **Read and Write**
   - Type of App: **Web App, Automated App or Bot**
   - Callback URI: `https://localhost`
   - Website URL: `https://eodin.app`
   - Organization name: `Eodin`
   - Organization URL: `https://eodin.app`
   - Terms of Service / Privacy Policy: 비워두기
   - 저장
3. **Keys and tokens** 탭:
   - 상단 **Consumer Keys** 섹션 → API Key + API Key Secret 복사
   - 하단 **Access Token and Secret** → **Generate** 클릭 → Access Token + Access Token Secret 복사

### 주의사항

- Bearer Token은 사용하지 않음 (App-only 인증용, 읽기 전용)
- adaria-ai는 OAuth 1.0a (4개 키)를 사용하여 포스팅
- Access Token Generate가 안 보이면 User authentication settings에서 Read and Write 권한 설정 먼저

---

## Facebook

### 필요한 값

| 항목 | 설명 |
|------|------|
| App ID | Facebook 앱 ID |
| App Secret | Facebook 앱 시크릿 |
| Access Token | 영구 Page Access Token (만료 없음) |
| Page ID | Facebook 페이지 숫자 ID |

### 사전 준비

1. https://developers.facebook.com 접속 → 앱 선택 (또는 새로 생성)
2. 앱 대시보드 → **이용 사례** → **이용 사례 더 추가하기**
3. **콘텐츠 관리** 카테고리 → **"페이지의 모든 부분 관리"** 추가
4. 추가된 use case의 권한 목록에서 `pages_manage_posts`, `pages_read_engagement` 를 **+ 추가**
5. **앱 설정 > 기본 설정**에서 App ID와 App Secret 복사

### 영구 Page Token 발급 (4단계)

아래 절차에서 `YOUR_APP_ID`, `YOUR_APP_SECRET`을 실제 값으로 교체.

#### Step 1: 브라우저에서 인증

아래 URL을 브라우저에 열기. 로그인 후 **반드시 페이지를 체크**하고 승인:

```
https://www.facebook.com/v24.0/dialog/oauth?client_id=YOUR_APP_ID&redirect_uri=https://localhost/&scope=pages_manage_posts,pages_read_engagement,pages_show_list&response_type=code&auth_type=rerequest
```

주소창이 `https://localhost/?code=XXXXX#_=_`로 바뀜. `code=` 뒤, `#_=_` 앞까지의 값이 CODE.

**주의:** redirect_uri는 반드시 `https://localhost/` (슬래시 포함). Facebook 앱 설정의 OAuth redirect URI와 정확히 일치해야 함.

#### Step 2: code → 단기 User Token

```
curl -s -X POST "https://graph.facebook.com/v24.0/oauth/access_token" \
  -d "client_id=YOUR_APP_ID" \
  -d "client_secret=YOUR_APP_SECRET" \
  -d "redirect_uri=https://localhost/" \
  -d "code=CODE"
```

응답의 `access_token`이 단기 User Token (약 1시간).

#### Step 3: 단기 → 장기 User Token (60일)

```
curl -s "https://graph.facebook.com/v24.0/oauth/access_token?grant_type=fb_exchange_token&client_id=YOUR_APP_ID&client_secret=YOUR_APP_SECRET&fb_exchange_token=SHORT_TOKEN"
```

응답의 `access_token`이 장기 User Token (60일).

#### Step 4: 장기 User Token → 영구 Page Token

`me/accounts`가 빈 배열을 반환하는 경우가 있음. 페이지 ID를 직접 지정하여 조회:

```
curl -s "https://graph.facebook.com/v24.0/PAGE_ID?fields=id,name,access_token&access_token=LONG_TOKEN"
```

응답의 `access_token`이 **영구 Page Token** (만료 없음).

여러 페이지가 있으면 각 PAGE_ID로 반복 실행.

### 페이지 ID 확인 방법

- Facebook 페이지 접속 → About 섹션에서 Page ID 확인
- 또는 브라우저 인증 시 페이지 선택 화면에 ID가 표시됨

### 토큰 검증

https://developers.facebook.com/tools/debug/accesstoken/ 에서:
- 유형: **Page**
- 만료: **만료 안 됨**

이 두 가지가 확인되면 성공.

### 트러블슈팅

| 문제 | 원인 | 해결 |
|------|------|------|
| `Invalid verification code format` | code가 잘린 것 | 주소창 URL 전체를 복사 (code= 뒤 전부, #_=_ 앞까지) |
| `redirect_uri does not match` | redirect_uri 불일치 | 반드시 `https://localhost/` (슬래시 포함) 사용 |
| `Invalid Scopes: manage_pages` | 구버전 권한 | 권한 초기화 후 `pages_manage_posts`만 사용 |
| `me/accounts`가 빈 배열 | 페이지 선택 안 함 또는 API 이슈 | PAGE_ID를 직접 지정하여 조회 |
| Graph API Explorer에서 권한이 안 보임 | use case 권한 미활성화 | 앱 대시보드 > 이용 사례 > 권한 목록에서 + 추가 |

---

## LinkedIn

### 필요한 값

| 항목 | 설명 |
|------|------|
| Access Token | OAuth 2.0 Bearer token (60일, refresh 가능) |
| Refresh Token | 토큰 갱신용 (1년) |
| Organization ID | LinkedIn 회사 페이지 숫자 ID |

### 사전 준비

1. https://www.linkedin.com/developers/apps 접속 → 앱 선택 (또는 새로 생성)
   - App name: 앱 이름
   - LinkedIn Page: 회사 페이지 연결 (Verified 상태 필요)
   - Privacy policy URL: `https://eodin.app/privacy` (또는 실제 URL)
2. **Products** 탭 → **Share on LinkedIn** → **Request access** → Added 확인
3. **Auth** 탭 → **OAuth 2.0 settings** → Authorized redirect URLs에 `https://localhost/` 추가
4. Client ID와 Client Secret 복사

### 토큰 발급 (2단계)

#### Step 1: 브라우저에서 인증

아래 URL을 브라우저에 열기 (CLIENT_ID를 교체):

```
https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=CLIENT_ID&redirect_uri=https://localhost/&scope=openid%20profile%20w_member_social%20w_organization_social%20r_organization_social&state=adaria123
```

승인 후 주소창이 `https://localhost/?code=XXXXX&state=adaria123`으로 바뀜. code 값 복사.

**주의:** `w_organization_social` 스코프 에러가 나면:
- Share on LinkedIn 제품이 Added 상태인지 확인
- 앱이 LinkedIn 회사 페이지에 Verified 연결되어 있는지 확인
- 안 되면 `w_organization_social`과 `r_organization_social`을 빼고 `w_member_social`만으로 개인 프로필 포스팅 가능

#### Step 2: code → Access Token + Refresh Token

```
curl -s -X POST "https://www.linkedin.com/oauth/v2/accessToken" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=CODE" \
  --data-urlencode "client_id=CLIENT_ID" \
  --data-urlencode "client_secret=CLIENT_SECRET" \
  --data-urlencode "redirect_uri=https://localhost/"
```

**중요:** `--data-urlencode`를 사용해야 함. `-d`로 하면 client_secret의 특수문자(`=`, `.`)가 깨져서 `invalid_client` 에러 발생.

응답:
- `access_token`: Bearer token (60일)
- `refresh_token`: 갱신용 (1년)
- `scope`: 부여된 권한 목록

### Organization ID 확인

```
curl -s -H "Authorization: Bearer ACCESS_TOKEN" \
  "https://api.linkedin.com/v2/organizations?q=vanityName&vanityName=YOUR_COMPANY_SLUG"
```

응답의 `elements[0].id`가 Organization ID.

회사 slug는 LinkedIn 회사 페이지 URL에서 확인: `https://www.linkedin.com/company/eodin` → slug는 `eodin`.

### 토큰 갱신 (만료 전)

```
curl -s -X POST "https://www.linkedin.com/oauth/v2/accessToken" \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "refresh_token=REFRESH_TOKEN" \
  --data-urlencode "client_id=CLIENT_ID" \
  --data-urlencode "client_secret=CLIENT_SECRET"
```

새 access_token + refresh_token 발급됨.

### 트러블슈팅

| 문제 | 원인 | 해결 |
|------|------|------|
| `redirect_uri does not match` | Auth 탭에서 redirect URL 미등록 | `https://localhost/` 추가 |
| `unauthorized_scope_error` | Share on LinkedIn 미승인 | Products 탭에서 Added 상태 확인 |
| `invalid_client` | client_secret 특수문자 깨짐 | `--data-urlencode` 사용 |
| Organization ID 403 | r_organization_social 권한 없음 | vanityName 쿼리로 직접 조회 |

---

## Threads

### 필요한 값

| 항목 | 설명 |
|------|------|
| Access Token | 장기 사용자 토큰 |
| User ID | Threads 사용자 ID |

### 발급 절차

Facebook 앱에서 **Threads API 액세스** use case를 추가한 후, Facebook과 동일한 OAuth 흐름으로 토큰 발급. scope에 `threads_basic`, `threads_content_publish` 추가.

(상세 절차는 Threads API 연동 시 추가 예정)

---

## TikTok

### 필요한 값

| 항목 | 설명 |
|------|------|
| Client Key | TikTok 앱 클라이언트 키 |
| Client Secret | TikTok 앱 클라이언트 시크릿 |
| Access Token | OAuth 2.0 사용자 토큰 |

### 참고

TikTok Content Posting API는 앱 리뷰가 필요함. 리뷰 승인 전까지 사용 불가.

(상세 절차는 TikTok 앱 리뷰 승인 후 추가 예정)

---

## YouTube

### 필요한 값

| 항목 | 설명 |
|------|------|
| Access Token | OAuth 2.0 Bearer token |
| Channel ID | YouTube 채널 ID |

### 발급 절차

1. https://console.cloud.google.com → APIs & Services → Credentials
2. OAuth 2.0 Client ID 생성 (Web application)
3. Authorized redirect URIs에 `https://localhost/` 추가
4. YouTube Data API v3 활성화 (API Library에서)
5. OAuth consent screen 설정
6. OAuth 흐름으로 토큰 발급

(상세 절차는 YouTube 연동 시 추가 예정)
