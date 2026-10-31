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

## Границы

- Не запускай реальный OpenCode с плагином на хосте: живые прогоны — только в
  `sandbox/`.
- Не устанавливай зависимости и не меняй `package.json`.
- Не переставляй правила и не удаляй чужие `deny`/`allow` вручную.
- Помни, что по умолчанию команда пишет в глобальный конфиг. Если пользователь
  просил только проект, добавь `--project`.
