# opencode-allow-classifier

Плагин разрешений OpenCode V2. Домен — `GLOSSARY.md`, решения — `docs/adr/`.

## Issue tracker

GitHub issues этого репозитория, через `gh`. Родительская спека — #1.
Метки: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`.

## Тесты

`node --test` с нативным TS-stripping. Новые тестовые зависимости не нужны.

## Живой OpenCode — только в `sandbox/`

Плагин перехватывает все shell-вызовы, поэтому запуск `opencode` с ним на хосте
управляет реальными командами разработчика и пишет в его state. Живые проверки —
только в контейнере, см. `sandbox/README.md`.

Профиль для тестов живёт в `sandbox/config/opencode.jsonc`. Хостовый
`~/.config/opencode/opencode.jsonc` при разработке не редактируется; если без этого
не обойтись — только по прямой просьбе, с перечнем изменений и способом откатить.
