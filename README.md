# opencode-allow-classifier

Плагин OpenCode V2, который понижает `ask → allow` для shell-команд по
контексту: команда, cwd, агент и последнее сообщение пользователя.

Статус — проектирование: спека и задачи в issues, решение в
[ADR-0001](docs/adr/0001-shell-permission-classifier.md), термины в
[GLOSSARY.md](GLOSSARY.md).

## Как работает

- В конфиге OpenCode стоит `shell: * → ask`, плагин понижает безопасное.
- Hard-ask до модели: `sudo`, установка пакетов, `git push`, `rm` вне cwd,
  миграции.
- Allowlist read-only команд с гардом на секреты.
- Jev отвечает вероятностью; порог 0.9, таймаут 3 с, ошибка оставляет `ask`.
- In-memory кэш и аудит JSONL.
- `/classifier` в TUI для выбора модели.

## Установка

Пока не опубликован. После реализации — локальный путь или npm-пакет.
