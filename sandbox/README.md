# Sandbox

Контейнер с OpenCode и этим плагином. Нужен, чтобы гонять headless-смоуки
и тесты в Linux, не подставляя рабочую систему: у агента внутри нет доступа
к `~/.ssh`, ключнице и домашнему каталогу, виден только репозиторий.

## Что внутри

- `opencode` 2.2.4 — standalone-бинарь с opencode.ai, версия и sha256
  закреплены в `Dockerfile`. Пакет `opencode-ai` из npm — это V1, не он.
- Node 26 (совпадает с хостом), `git`, `ripgrep`, `jq`.
- Профиль [`config/opencode.jsonc`](config/opencode.jsonc): тот же catch-all
  `shell: * → ask` и те же deny-правила, что на хосте. Плагин подключён
  локальным путём `/home/node/repo`, поэтому правки в `src/` подхватываются
  без пересборки образа. `include_system_context` в профиле выключен, как и
  в пользовательском конфиге.

`--auto` здесь намеренно не используется: с ним хук вообще не вызывается
для `allow`, и проверять классификатор становится не на чем. Headless-прогон
сам отклоняет `ask`, так что подтверждений всё равно не спрашивает.

## Первый запуск

Собрать образ и залить креды провайдеров в volume (секреты не попадают
в образ и в репозиторий):

```sh
docker compose -f sandbox/compose.yaml build
opencode auth export | docker compose -f sandbox/compose.yaml run --rm -T agent opencode auth import
```

Креды живут в named volume `opencode-sandbox_opencode-data`. Повторять
импорт нужно только при смене ключей или после `docker volume rm`.

## Тесты

```sh
docker compose -f sandbox/compose.yaml run --rm -T agent npm test
docker compose -f sandbox/compose.yaml run --rm -T agent npm run typecheck
```

`node_modules` репозитория подменяется отдельным volume: macOS-зависимости
хоста не смешиваются с Linux-зависимостями контейнера. Установка происходит
автоматически при первом старте.

## Смоук

Headless-прогон без интерактива; решения видны в аудите.

```sh
docker compose -f sandbox/compose.yaml run --rm -T agent \
  opencode run --standalone --model deepseek/deepseek-flash \
  "Run exactly one shell tool call: ls. Do not do anything else."
```

Что проверять:

- `ls` проходит и попадает в аудит как `allow`/`allowlist`;
- `sudo -n true` отклоняется как `ask`/`hard-ask`;
- `cat .env` отклоняется как `ask`/`guard:secret-env`.

Приёмочный чек-лист. Отмечай по факту прогона, а не по ожиданию.

- [ ] `ls` проходит без подтверждения, аудит пишет `allow`/`allowlist`.
- [ ] `sudo -n true` остаётся `ask` с `source: hard-ask`, модель не
      вызывается.
- [ ] Команда вне allowlist, безопасная по контексту (например,
      `sed -n '1,20p' README.md`), получает `allow` с `source: model`.
- [ ] Опасная команда внутри cwd (например, `rm build/old.log`) остаётся
      `ask` с `source: model`.
- [ ] Повтор той же команды в том же cwd даёт `source: cache` и не вызывает
      модель.
- [ ] `/classifier` открывается, выбор модели переживает рестарт TUI и
      сервера.
- [ ] `enabled: false` (V2 перезагружает плагин сам, `/reload` — если не
      подхватилось): `ls` снова спрашивает, `/classifier` пропадает из
      автодополнения.

System-смоук: включи `"include_system_context": true` в
`sandbox/config/opencode.jsonc`, начни сессию, измени `AGENTS.md` и продолжи
её (`opencode run --session <id>`). OpenCode пришлёт system-сообщение с diff,
а аудит запишет `systemContext.used: true`, длину и хеш — без текста.

Аудит пишется в `sandbox/.runtime/` на хосте:

```sh
tail -f sandbox/.runtime/audit/evaluate-*.jsonl
```

## TUI-смоук

Смоук пройден в контейнере: пикер открывается, Jev идёт категорией
`System One`, выбор переживает рестарт, headless использует сохранённый
оверрайд. Тост вызывает `ctx.ui.toast.show`; тесты проверяют вызов и
обработку ошибок. Запускать из интерактивного терминала:
`docker compose run` без `-T` выделяет TTY.

```sh
docker compose -f sandbox/compose.yaml run --rm agent opencode
```

В TUI:

1. выполнить `/classifier` — открывается пикер decision-моделей, текущая
   модель подсвечена, Jev идёт категорией `System One`;
2. выбрать другую модель — появляется тост `Classifier model: <модель>`;
3. выйти из TUI и повторить запуск той же командой;
4. снова открыть `/classifier` — выбранная модель должна быть текущей.

Оверрайд лежит в серверном `ctx.storage`, а не в состоянии TUI, поэтому
рестарт контейнера его не теряет: данные живут в volume
`opencode-sandbox_opencode-data`. Headless-прогон команды, которая доходит
до модели, должен писать в аудит выбранную модель в поле `model`.

## Что монтируется

| Хост | Контейнер | Режим |
|---|---|---|
| репозиторий | `/home/node/repo` | rw |
| `sandbox/config` | `/opt/sandbox-config` | ro, копируется в config volume при старте |
| `sandbox/.runtime` | `/sandbox-runtime` | rw |

Docker-сокет, `~/.ssh`, `~/.config/opencode` и ключница не монтируются.

## Границы

Репозиторий примонтирован на запись: агент внутри может снести рабочее
дерево. Спасает git, а не контейнер. Задача контейнера — сохранить систему
и секреты, а не репозиторий.

## Сброс

```sh
docker compose -f sandbox/compose.yaml down
docker volume rm opencode-sandbox_opencode-data opencode-sandbox_opencode-config
```

После этого нужен повторный `auth import`.
