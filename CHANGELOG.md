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

### Исправлено

- Гард ловит метасимволы и подстановки внутри одного ресурса: `;`, перевод
  строки, `&`, глобы, `$'…'`, скобки и обратный слэш больше не проходят как
  `cat`.
- Гард сверяет секреты с сырым текстом, текстом без кавычек и склеенными
  токенами, поэтому `cat ".en""v"` и `cat .e''nv` больше не читают `.env`.
- Список секретов расширен: `.netrc`, `.npmrc`, `.pgpass`,
  `.git-credentials`, `.docker/config.json`, `.kube/config`, `.aws/`,
  `.config/gh`, history-файлы, `*.pem`, `/proc/`, `secrets`; отдельно
  закрыты флаги чтения файла (`--contents`, `--slurpfile`, `--rawfile`,
  `--from-file`, `jq -f`) и дамп окружения через `jq env`.
- `git --ext-diff` и `--textconv` больше не считаются read-only.
- Hard-ask видит программу за env-префиксами, обёртками и глобальными
  флагами git: `git -C /tmp push`, `FOO=1 sudo`, `nohup sudo`, `doas`,
  `sudoedit`; добавлены `npm ci`, голые `yarn`/`pnpm`, `--prefix`,
  `python -m pip install`, `uv sync`, `cargo install`, `brew upgrade`.

