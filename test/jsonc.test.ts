import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEdits,
  findDuplicateKeys,
  insertArrayItem,
  insertArrayItems,
  insertObjectMember,
  insertObjectMembers,
  parseJsonc,
  replaceNode,
  toValue,
} from "../scripts/jsonc.ts";
import type { JsoncArrayNode, JsoncObjectNode } from "../scripts/jsonc.ts";

const FIXTURE = `// leading comment
{
  "$schema": "https://opencode.ai/config.json",
  /* block comment */
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "rm -rf*", "effect": "deny" }, // trailing comma
  ],
  "plugins": [
    {
      "package": "/repo",
      "options": { "enabled": true, "threshold": 0.9, "name": "a\\u002Fb", },
    },
  ],
}
`;

test("jsonc parses comments, trailing commas and nested values with source offsets", () => {
  const document = parseJsonc(FIXTURE);

  assert.deepEqual(toValue(document.root), {
    $schema: "https://opencode.ai/config.json",
    permissions: [
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "rm -rf*", effect: "deny" },
    ],
    plugins: [{ package: "/repo", options: { enabled: true, threshold: 0.9, name: "a/b" } }],
  });

  assert.equal(document.root.type, "object");
  assert.equal(FIXTURE.slice(document.root.start, document.root.end), FIXTURE.trim().slice(FIXTURE.trim().indexOf("{")));
  assert.equal(FIXTURE.slice(document.root.start, document.root.start + 1), "{");
  assert.equal(FIXTURE.slice(document.root.end - 1, document.root.end), "}");

  const root = document.root as JsoncObjectNode;
  const permissions = root.members[1]!.value as JsoncArrayNode;
  const firstRule = permissions.items[0] as JsoncObjectNode;
  const resource = firstRule.members[1]!;

  assert.equal(FIXTURE.slice(firstRule.start, firstRule.end), '{ "action": "shell", "resource": "*", "effect": "ask" }');
  assert.equal(FIXTURE.slice(resource.key.start, resource.key.end), '"resource"');
  assert.equal(FIXTURE.slice(resource.value.start, resource.value.end), '"*"');
  assert.equal(resource.end, resource.value.end);
});

test("jsonc edits insert into objects and arrays without rewriting comments or formatting", () => {
  const document = parseJsonc(FIXTURE);
  const root = document.root as JsoncObjectNode;
  const permissions = root.members[1]!.value as JsoncArrayNode;
  const allowAll = permissions.items[0] as JsoncObjectNode;
  const name = allowAll.members[1]!.value;

  const edits = [
    insertObjectMember(document, root, '"added": true'),
    insertArrayItem(document, permissions, '{ "action": "shell", "resource": "git push*", "effect": "deny" }'),
    replaceNode(name, '"**"'),
  ];

  assert.equal(
    applyEdits(FIXTURE, edits),
    `// leading comment
{
  "$schema": "https://opencode.ai/config.json",
  /* block comment */
  "permissions": [
    { "action": "shell", "resource": "**", "effect": "ask" },
    { "action": "shell", "resource": "rm -rf*", "effect": "deny" }, // trailing comma
    { "action": "shell", "resource": "git push*", "effect": "deny" }
  ],
  "plugins": [
    {
      "package": "/repo",
      "options": { "enabled": true, "threshold": 0.9, "name": "a\\u002Fb", },
    },
  ],
  "added": true
}
`,
  );
});

test("jsonc inserts array items before an existing item", () => {
  const text = `{
  "rules": [
    { "name": "first" },
    { "name": "second" }
  ]
}
`;
  const document = parseJsonc(text);
  const rules = (document.root as JsoncObjectNode).members[0]!.value as JsoncArrayNode;

  const result = applyEdits(text, [insertArrayItems(document, rules, 0, ['{ "name": "catch-all" }'])]);

  assert.equal(
    result,
    `{
  "rules": [
    { "name": "catch-all" },
    { "name": "first" },
    { "name": "second" }
  ]
}
`,
  );
});

test("jsonc inserts several members into an empty object", () => {
  const document = parseJsonc("{}");
  const root = document.root as JsoncObjectNode;

  const result = applyEdits("{}", [insertObjectMembers(document, root, ['"a": 1', '"b": 2'])]);

  assert.equal(result, `{
  "a": 1,
  "b": 2
}`);
});

test("jsonc reports duplicate keys but keeps the last value", () => {
  const document = parseJsonc('{ "a": 1, "a": 2, "nested": { "b": true, "b": false } }');

  assert.deepEqual(toValue(document.root), { a: 2, nested: { b: false } });
  assert.deepEqual(findDuplicateKeys(document.root), [
    { path: "$", key: "a" },
    { path: "$.nested", key: "b" },
  ]);
});

test("jsonc rejects invalid syntax with a positioned error", () => {
  assert.throws(() => parseJsonc('{ "a": 1, } trailing'), /line 1, column 13/);
  assert.throws(() => parseJsonc('{ "a": 01 }'), /line 1, column 9/);
  assert.throws(() => parseJsonc('{ "a": "unterminated }'), /line 1, column 8/);
  assert.throws(() => parseJsonc("[1, 2"), /unexpected end of input/);
  assert.throws(() => parseJsonc('{ "a": tru }'), /line 1, column 8/);
});
