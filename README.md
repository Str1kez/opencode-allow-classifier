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
- Allowlist read-only команд внутри cwd, с гардом на секреты и запись.
- Jev отвечает вероятностью; порог 0.9, таймаут 3 с, ошибка оставляет `ask`.
- In-memory кэш и аудит JSONL.
- `/classifier` в TUI для выбора модели.

## Установка

Политика конфига и подключение плагина — в [docs/permissions.md](docs/permissions.md).
Пока пакет не опубликован, dotfiles подключают его локальным путём.

## Разработка в контейнере

Тесты и headless-смоуки гоняются в Docker, без доступа к домашнему каталогу
хоста: [sandbox/README.md](sandbox/README.md).
