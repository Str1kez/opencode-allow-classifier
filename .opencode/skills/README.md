# Скиллы классификатора

Два скилла репозитория: установка и разбор аудита. OpenCode находит их сам,
когда открыт в этом репозитории: править домашний конфиг, ставить симлинки и
прописывать `skills` не нужно.

Детерминированная работа живёт в скриптах, `SKILL.md` — только суждение: что
показать, что спросить и как трактовать результат. Общие модули обоих скиллов
лежат в корневом [`scripts/`](../../scripts), в каталогах скиллов остаются
CLI-точки входа.

## `allow-classifier-install`

Ставит плагин в глобальный или проектный конфиг OpenCode: catch-all `ask`
первым shell-правилом, `external_directory` `* → ask`, deny после него, объект
плагина с опциями. Повторный запуск ничего не дублирует, комментарии и чужие
правила сохраняет. Если порядок правил сломан, показывает diff и
останавливается.

Вызов — попросить агента:

> Вызови скилл `allow-classifier-install` и помоги установить плагин
> `opencode-allow-classifier`.

Или запустить CLI напрямую:

```sh
node .opencode/skills/allow-classifier-install/scripts/cli.ts install
node .opencode/skills/allow-classifier-install/scripts/cli.ts install --project
node .opencode/skills/allow-classifier-install/scripts/cli.ts inspect --json
node .opencode/skills/allow-classifier-install/scripts/cli.ts verify
node .opencode/skills/allow-classifier-install/scripts/cli.ts rollback
```

Цель по умолчанию — глобальный `$XDG_CONFIG_HOME/opencode/opencode.jsonc`,
иначе `~/.config/opencode/opencode.jsonc`. `--project` берёт конфиг проекта,
`--config <path>` указывает точный файл и побеждает `--project`. Оба
используются только по явной просьбе: по умолчанию классификатор ставится во
все проекты.

`install` печатает diff до записи; `inspect` только читает; `verify` проверяет
версию харнесса, зависимости, запись плагина, kill switch и сухой прогон
решателя; `rollback` снимает ровно добавленное установкой и только по явной
просьбе. Живой OpenCode скилл не запускает: живые прогоны — в
[`sandbox/`](../../sandbox/README.md).

Подробности и границы — в
[SKILL.md](allow-classifier-install/SKILL.md).

## `allow-classifier-analyze`

Разбирает аудит за окно и группирует `ask` по сигнатуре команды. Показывает
вхождения, вероятность, источники, сработавшие правила, проекты и агентов,
пример команды, раскладывает кластеры по рычагам и предлагает рекомендации по
безопасности. Ничего не пишет: это отчёт, применение — отдельная команда.

```sh
npm run report
npm run report -- --since=7d --source=model --json
npm run report -- --rule='guard:*'
npm run report -- --config ./opencode.jsonc --audit-dir /path/to/audit
```

Окно по умолчанию — 30 дней. `--since` принимает `YYYY-MM-DD` или `<n>d`,
`--config` задаёт конфиг с `audit_dir` и `threshold`, `--audit-dir`
переопределяет каталог, `--source` фильтрует по источнику, `--rule` — по глобу
имени правила, `--json` печатает стабильный JSON. Аудит `sandbox/` и
`sandbox-runtime/` по умолчанию исключён; для него нужен `--include-sandbox`.

Отчёт по умолчанию идёт в чат: в аудите лежит `task` — текст последнего
сообщения пользователя, поэтому файл создаётся только по явной просьбе.

Подробности и полный список флагов — в
[SKILL.md](allow-classifier-analyze/SKILL.md).
