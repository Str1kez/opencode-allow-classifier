# TODO

## В работе

- #3 auto mode: hard-ask, allowlist с гардом, аудит и kill switch — реализовано,
  e2e в `sandbox/` пройден (allowlist, hard-ask, guard `cat .env`,
  deny `git push --force` без записи в аудит).
- #4 классификатор: Jev, порог 0.9, таймаут 3 с, кэш — реализовано, смоук
  в `sandbox/` пройден (`allow` 0.92, повтор из кэша, `ask` при пороге 0.99,
  `timeout_ms: 1` → `ask`/`error`).
- #5 `/classifier` в TUI и RPC-контракт — реализовано, смоук в `sandbox/`
  пройден:
  - [x] пикер открывается, Jev идёт категорией `System One`, текущая модель
        подсвечена; выбор сохраняется в `ctx.storage` и переживает рестарт;
        тост `Classifier model: …` вызывается (проверено тестом и логом
        `toast.show`; визуально в agterm-захвате не поймали);
  - [x] headless-запуск использует сохранённый оверрайд: аудит пишет
        `source:"model"`, выбранную модель и `allow` при вероятности 0.92;
  - [x] повторный TUI-смоук #6: `/classifier` открывает диалог, видны
        `System One` и `jev-1.13-free`, Esc закрывает без изменений.
- #6 раскатка: README, CHANGELOG, удаление `log_raw` — готово; e2e в
  `sandbox/` пройден:
  - [x] allowlist: `ls` → `allow`/`allowlist`;
  - [x] hard-ask: `sudo -n true` → `ask`/`hard-ask`;
  - [x] classifier allow: `printf classifier-allow-e2e` → `allow`/`model`,
        0.92;
  - [x] classifier ask: `printf classifier-ask-threshold` при пороге 0.99 →
        `ask`/`model`, 0.9;
  - [x] cache: две одинаковые команды в одной сессии → `model`, затем
        `cache`;
  - [x] kill switch: `enabled:false` → `ls` спрашивает, аудит пуст;
  - [x] `timeout_ms` 1 → `ask`/`error`, `classifier:timeout`;
  - [x] `/classifier` в TUI: диалог открывается, видны `System One` и
        `jev-1.13-free`, Esc закрывает без изменений;
  - [x] локальное подключение по пути `/home/node/repo` работает;
  - [x] установка через симлинк: `package` → `/tmp/plugin-link` →
        `/home/node/repo`, `ls` → `allow`/`allowlist`.
- #7 system-сообщение в контексте классификатора — реализовано: опция
  `include_system_context` (по умолчанию `false`), лимит 2000 символов,
  экранирование, хеш в ключе кэша, аудит без текста, один запрос к сессии
  с таймаутом; тесты и typecheck зелёные на хосте и в sandbox. E2E в
  sandbox: при дефолте аудит пишет `used:false`; после правки `AGENTS.md`
  в живой сессии system-сообщение доходит до классификатора
  (`used:true`, length 387, хеш совпал с текстом сообщения); `sudo` →
  `hard-ask`, `cat .env` → `guard:secret-env`, `git push --force` → `deny`
  без записи в аудит.

## Следующее

- Закоммитить #6 и закрыть issue. Публикация пакета в npm остаётся вне
  скоупа: `package.json` — `private`, установка локальным путём.

