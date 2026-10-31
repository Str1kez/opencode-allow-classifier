---
name: allow-classifier-install
description: Поставить плагин классификатора shell-команд в глобальный или проектный конфиг OpenCode и показать состояние правил, записи плагина и kill switch.
---

# Установка классификатора

Скилл ставит политику `opencode-allow-classifier` в конфиг OpenCode и показывает,
что уже настроено. Вся детерминированная работа — в скрипте; решение о цели и
трактовка вывода остаются за тобой.

## Когда использовать

- Пользователь просит поставить классификатор или включить auto mode.
- Нужно проверить, почему `ask` не понижается: порядок правил, запись плагина,
  `enabled: false`.
- Нужно убедиться, что установка уже применена и повторный запуск ничего не
  изменит.

## Команды

Запускай из корня репозитория, где лежит `.opencode`:

```sh
# глобальный конфиг по умолчанию
node .opencode/skills/allow-classifier-install/scripts/cli.ts install

# только текущий проект
node .opencode/skills/allow-classifier-install/scripts/cli.ts install --project

# конкретный файл
node .opencode/skills/allow-classifier-install/scripts/cli.ts install --config /path/to/opencode.jsonc
```

`inspect` ничего не пишет:

```sh
node .opencode/skills/allow-classifier-install/scripts/cli.ts inspect
node .opencode/skills/allow-classifier-install/scripts/cli.ts inspect --project
node .opencode/skills/allow-classifier-install/scripts/cli.ts inspect --config /path/to/opencode.jsonc
node .opencode/skills/allow-classifier-install/scripts/cli.ts inspect --config /path/to/opencode.jsonc --json
```

Цель по умолчанию — `$XDG_CONFIG_HOME/opencode/opencode.jsonc`, иначе
`~/.config/opencode/opencode.jsonc`. `--project` берёт `./opencode.jsonc` текущего
каталога. `--config` указывает точный файл и побеждает `--project`.

## Что делает install

- Создаёт файл и недостающие каталоги, если конфига нет.
- Заменяет пустой или состоящий из пробелов файл чистой раскладкой.
- На уже настроенном конфиге не меняет ничего и печатает `no changes`.
- Чистая раскладка: `$schema`, catch-all `ask` первым правилом для `shell`,
  шесть deny-правил после него, запись плагина объектом с
  `options: { "enabled": true }` и абсолютным путём к корню пакета.
- Код возврата `0` — файл создан или уже настроен. Иначе `1`.

Если конфиг валиден, но это не чистая раскладка, скрипт останавливается и
печатает отказ; файл остаётся байт в байт. Не обходи отказ ручной правкой и не
подменяй путь через `--config`: покажи сообщение пользователю и спроси, что он
хочет сделать со своим конфигом.

## Что показывает inspect

Путь, существование, правила в порядке применения с индексами, первый ли
catch-all среди shell-правил, стоят ли deny после него, тип записи плагина, путь
пакета, наличие и тип `options`, состояние kill switch (`enabled: false`) и
предупреждения. На читаемом конфиге код возврата `0` даже при предупреждениях:
это отчёт, а не проверка. Ошибка чтения или разбора даёт ненулевой код.

`--json` печатает тот же отчёт стабильной структурой — используй его, когда нужно
сравнить два состояния или передать данные дальше.

## Проверка после установки

`verify` ничего не пишет и не запускает опасных команд: читает конфиг, проверяет
версию харнесса и зависимости, делает сухой прогон решателя и печатает чек-лист
для живой проверки.

```sh
node .opencode/skills/allow-classifier-install/scripts/cli.ts verify
node .opencode/skills/allow-classifier-install/scripts/cli.ts verify --config /path/to/opencode.jsonc
node .opencode/skills/allow-classifier-install/scripts/cli.ts verify --harness-version 2.2.5
node .opencode/skills/allow-classifier-install/scripts/cli.ts verify --deps-root /path/to/repo
```

Цель конфига резолвится так же, как у `install`: `--config`, `--project`, иначе
глобальный файл. Что проверяется:

- конфиг: отсутствие, ошибка чтения или разбора — `FAIL`;
- запись плагина: нет записи или она строкой — `FAIL` (опции не дойдут),
  объект — `PASS`;
- kill switch: `enabled: false` — `FAIL`, отсутствующие опции или неизвестное
  значение — `WARN` (плагин по умолчанию включён), `enabled: true` — `PASS`;
- версия харнесса: `--harness-version` подменяет пробу, иначе один вызов
  `opencode --version`; 2.2.x — `PASS`, другая версия, отсутствующий бинарь или
  нечитаемый вывод — `WARN` и на код возврата не влияют;
- зависимости `@opencode/plugin` и `effect` под `--deps-root` (по умолчанию корень
  репозитория): отсутствие — `FAIL`;
- сухой прогон `decide()`: `sudo -n true` даёт hard-ask `sudo`, `cat .env` —
  `guard:secret-env`, `cat ../secret.txt` — `guard:outside-cwd`, `ls` — allow.
  Команды при этом не выполняются.

`verify: ok` и код `0`, если нет ни одного `FAIL`; предупреждения не блокируют.
`verify: failed` и код `1` — есть хотя бы один `FAIL`.

### Живое доказательство

Скрипт печатает каталог аудита: опция `audit_dir` из конфига, иначе state-каталог
OpenCode. Дальше проверяет человек:

1. Открой этот репозиторий в OpenCode.
2. Выполни безопасную read-only команду, например `ls`.
3. Найди в `evaluate-*.jsonl` свежую запись с `verdict: "allow"` и
   `source: "allowlist"`.

V2 перезагружает конфиги, плагины и скиллы сам: перезапуск не нужен, `/reload` —
принудительный путь.

### Границы проверки

- Скрипт никогда не запускает OpenCode с плагином на хосте: `opencode --version`
  это проба версии, а не сессия. Живые прогоны — только в `sandbox/`.
- `sudo`, `cat .env` и подобное на хосте не выполняются ни в каком режиме: сухой
  прогон идёт через `decide()`.

## Границы

- Не запускай реальный OpenCode с плагином на хосте: живые прогоны — только в
  `sandbox/`.
- Не устанавливай зависимости и не меняй `package.json`.
- Не переставляй правила и не удаляй чужие `deny`/`allow` вручную.
- Помни, что по умолчанию команда пишет в глобальный конфиг. Если пользователь
  просил только проект, добавь `--project`.
