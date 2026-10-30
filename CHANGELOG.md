# CHANGELOG

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).

## [Unreleased]

### Добавлено

- Пайплайн auto mode без модели: hard-ask, allowlist read-only команд с
  гардом на секреты и записи, дефолт `ask`.
- Аудит решений в `evaluate-YYYY-MM.jsonl` в state-каталоге OpenCode;
  ошибка записи не влияет на вердикт.
- Kill switch `enabled: false` — плагин не регистрирует хук.
- `docs/permissions.md` с фрагментом `opencode.jsonc`: catch-all, deny после
  него и подключение плагина объектом с опциями.

