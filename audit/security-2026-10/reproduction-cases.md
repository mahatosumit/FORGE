# FORGE — Reproduction Cases (minimal, self-contained)

Environment for all cases: fixed tree at `D:\quack pro\forge`, Node v26.11.1.
Isolated instance: `node --import tsx audit/security-2026-10/tools/audit-server.mts` (writes `audit/security-2026-10/instance.json`; port 3131; temp data/workspace; mock model). **None of these cases touch real user data.**

## RC-01 — F-03 junction escape (pre-fix: ESCAPED; post-fix: blocked)
```
node --import tsx audit/security-2026-10/tools/repro-junction-escape.mts
```
Pre-fix output (excerpt): `ESCAPED putFile through dir-junction — gate=allow fileOutside=true`
Post-fix output (all): `blocked readFile/putFile/exec cwd through dir-junction`; drive-relative/ADS/trailing-dot/space also blocked.
Expected vs actual:
- Expected: `PathEscapeError`, nothing outside the workspace.
- Pre-fix actual: file created in the junction target outside; read returned outside content; exec cwd escaped.

## RC-02 — F-01 Host/Origin gate (pre-fix: 200; post-fix: 403)
```
$i = Get-Content audit/security-2026-10/instance.json -Raw | ConvertFrom-Json
curl.exe -s -o NUL -w "%{http_code}" -H "Host: evil.example.com" http://127.0.0.1:3131/            # fixed: 403
curl.exe -s -o NUL -w "%{http_code}" -H "Origin: https://evil.example.com" -H "Authorization: Bearer $($i.token)" http://127.0.0.1:3131/health   # fixed: 403
curl.exe -s -o NUL -w "%{http_code}" -H "Authorization: Bearer $($i.token)" http://127.0.0.1:3131/health   # 200
```

## RC-03 — F-07 false corruption on continued missions (pre-fix: 500 corruption; post-fix: 409 clean)
```
# create mission (mock model closes it quickly), then continue, then resume:
Set-Content "$env:TEMP\c1.json" '{"intent":"continuation audit mission"}'
$m = curl.exe -s -X POST -H "Authorization: Bearer $($i.token)" -H "content-type: application/json" --data-binary "@$env:TEMP\c1.json" http://127.0.0.1:3131/missions | ConvertFrom-Json
Start-Sleep 4
Set-Content "$env:TEMP\c2.json" '{"content":"continue please"}'
curl.exe -s -X POST -H "Authorization: Bearer $($i.token)" -H "content-type: application/json" --data-binary "@$env:TEMP\c2.json" http://127.0.0.1:3131/missions/$($m.missionId)/directive   # 200
curl.exe -s -X POST -H "Authorization: Bearer $($i.token)" http://127.0.0.1:3131/missions/$($m.missionId)/resume                                                                    # fixed: 409 "closed — resume rejected"
```
Pre-fix actual: HTTP 500 `journal corruption at seq N: prev-hash-mismatch — journal altered after closure`.
Chain proof: `node --import tsx audit/security-2026-10/tools/verify-closed-mission-journal.mts` → `verifyChain: OK`, every hash recomputes.

## RC-04 — F-02 headers
```
curl.exe -s -D - -o NUL http://127.0.0.1:3131/ | findstr /I "content-security x-frame x-content cache"
```
Fixed: CSP with `frame-ancestors 'none'`, `x-frame-options: DENY`, `nosniff`, `no-store`.

## RC-05 — F-04 attached eval flag
Unit-level (in `test/security/audit-2026-10-regressions.test.ts`): `evaluateProposal(["node","-eprintln(1)"])` against grant `argv-prefix ["node"]` → pre-fix `allow`, fixed `escalate`.

## RC-06 — F-06 IPv6 cross-match
Unit-level: grant `hosts ["[::1]"]` + `web_fetch http://[2001:db8::beef]/` → pre-fix `allow`, fixed non-allow.

## RC-07 — Stored hostile goal rendering (no defect; recorded as control)
```
Set-Content "$env:TEMP\b2.json" '{"intent":"<img src=x onerror=alert(2)>"}'
curl.exe -s -X POST -H "Authorization: Bearer $($i.token)" -H "content-type: application/json" --data-binary "@$env:TEMP\b2.json" http://127.0.0.1:3131/missions
node audit/security-2026-10/tools/browser-xss-and-closure.mjs
```
Result: `dialog (alert) fired: 0`, `img element injected into DOM: 0`, `literal text rendered: true`.

## RC-08 — UI under CSP (post-fix sanity)
```
node audit/security-2026-10/tools/verify-ui-isolated.mjs
```
Result: title correct, board renders, mission + receipt tab open, `problems: none` (no CSP violations, no JS errors, no 4xx).
