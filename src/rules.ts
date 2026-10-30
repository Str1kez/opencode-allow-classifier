/**
 * Rule tables. Everything a rule can decide lives here as data; `policy.ts` only walks the tables.
 * Adding a command or a secret guard means adding an entry, not touching the pipeline.
 */

/** A command shape that always goes to the human, before the model is ever considered. */
export interface HardAskRule {
  /** Stable id written to the audit log. */
  readonly name: string;
  /** Program names, compared with `basename`, so `/usr/bin/sudo` matches `sudo`. */
  readonly programs: readonly string[];
  /**
   * Accepted token runs right after the program; any one of them is enough. Absent means the program
   * alone triggers the rule. `uv pip install` is `["pip", "install"]` under program `uv`.
   */
  readonly arguments?: readonly (readonly string[])[];
  /** Extra predicate applied to the operands; only `rm` uses it today. */
  readonly scope?: "outside-cwd";
}

/**
 * Commands that are read-only no matter the arguments, except where a whitelist is declared.
 * `sed`, `awk`, `find` and `env` are deliberately absent: they execute or rewrite.
 */
export interface AllowlistRule {
  /** Stable id written to the audit log. */
  readonly name: string;
  /** Tokens that must open the segment. The first token is compared by basename. */
  readonly prefix: readonly string[];
  /** Reject anything past the prefix; `git remote -v add …` is not a listing. */
  readonly exact?: boolean;
  /** When set, every token past the prefix must be one of these. Blocks `git branch -D main`. */
  readonly allowedTokens?: readonly string[];
}

export const HARD_ASK_RULES: readonly HardAskRule[] = [
  // Privilege escalation.
  { name: "sudo", programs: ["sudo"] },

  // Package installation: reaches the network and rewrites the environment.
  { name: "npm-install", programs: ["npm", "pnpm", "yarn"], arguments: [["install"], ["i"], ["add"]] },
  { name: "pip-install", programs: ["pip", "pip3"], arguments: [["install"]] },
  { name: "uv-install", programs: ["uv"], arguments: [["pip", "install"], ["add"]] },
  { name: "brew-install", programs: ["brew"], arguments: [["install"]] },

  // Publishing state outside the machine.
  { name: "git-push", programs: ["git"], arguments: [["push"]] },

  // Irreversible deletion outside the working directory.
  { name: "rm-outside-cwd", programs: ["rm"], scope: "outside-cwd" },

  // Schema migrations: change shared state and are hard to undo.
  { name: "alembic-migration", programs: ["alembic"], arguments: [["upgrade"]] },
  { name: "prisma-migration", programs: ["prisma"], arguments: [["migrate"]] },
  { name: "goose-migration", programs: ["goose"] },
  { name: "flyway-migration", programs: ["flyway"] },
];

export const ALLOWLIST_RULES: readonly AllowlistRule[] = [
  { name: "ls", prefix: ["ls"] },
  { name: "pwd", prefix: ["pwd"] },
  { name: "cat", prefix: ["cat"] },
  { name: "head", prefix: ["head"] },
  { name: "tail", prefix: ["tail"] },
  { name: "wc", prefix: ["wc"] },
  { name: "file", prefix: ["file"] },
  { name: "stat", prefix: ["stat"] },
  { name: "du", prefix: ["du"] },
  { name: "df", prefix: ["df"] },
  { name: "which", prefix: ["which"] },
  { name: "echo", prefix: ["echo"] },
  { name: "date", prefix: ["date"] },
  { name: "whoami", prefix: ["whoami"] },
  { name: "uname", prefix: ["uname"] },
  { name: "rg", prefix: ["rg"] },
  { name: "grep", prefix: ["grep"] },
  { name: "jq", prefix: ["jq"] },
  { name: "git-status", prefix: ["git", "status"] },
  { name: "git-diff", prefix: ["git", "diff"] },
  { name: "git-log", prefix: ["git", "log"] },
  { name: "git-show", prefix: ["git", "show"] },
  {
    name: "git-branch",
    prefix: ["git", "branch"],
    // `git branch -D main` deletes, `git branch feature` creates. Only listing flags pass.
    allowedTokens: ["-a", "-r", "-v", "-vv", "-l", "--all", "--remotes", "--verbose", "--list", "--show-current", "--no-color"],
  },
  { name: "git-remote-v", prefix: ["git", "remote", "-v"], exact: true },
  { name: "git-rev-parse", prefix: ["git", "rev-parse"] },
  { name: "git-blame", prefix: ["git", "blame"] },
  { name: "git-stash-list", prefix: ["git", "stash", "list"] },
];

/**
 * Guard: cancels the allowlist. Matched against the whole resource string because a redirection is
 * part of the resource, never a separate field.
 */
export type GuardRule =
  | { readonly name: string; readonly kind: "substring"; readonly value: string }
  | { readonly name: string; readonly kind: "token"; readonly values: readonly string[] }
  | { readonly name: string; readonly kind: "short-flag"; readonly value: string }
  | { readonly name: string; readonly kind: "long-flag"; readonly value: string };

export const GUARD_RULES: readonly GuardRule[] = [
  // Secrets a read-only command could otherwise print.
  { name: "secret-env", kind: "substring", value: ".env" },
  { name: "secret-ssh", kind: "substring", value: ".ssh" },
  { name: "secret-id-rsa", kind: "substring", value: "id_rsa" },
  { name: "secret-credentials", kind: "substring", value: "credentials" },
  { name: "system-etc", kind: "substring", value: "/etc/" },

  // Any write: `>` also covers `>>`, `2>` and `&>`.
  { name: "redirect", kind: "substring", value: ">" },
  { name: "tee", kind: "token", values: ["tee"] },
  { name: "output-short-flag", kind: "short-flag", value: "-o" },
  { name: "output-long-flag", kind: "long-flag", value: "--output" },

  // Executors hidden inside "read-only" tooling.
  { name: "rg-preprocessor", kind: "long-flag", value: "--pre" },
  { name: "rg-preprocessor", kind: "long-flag", value: "--pre-glob" },

  // A scanner that failed to split leaves chaining inside one resource; never allow that.
  { name: "shell-operator", kind: "token", values: [";", "&", "&&", "|", "||", "`"] },
  { name: "shell-substitution", kind: "substring", value: "$(" },
  // Backticks are the other substitution form. Matched as a substring: the tokenizer glues a backtick
  // to the command it wraps, so the token rule above never sees a bare one.
  { name: "shell-backtick", kind: "substring", value: "`" },
];
