---
name: percolator-config
description: Use when the user wants to create or modify a Percolator config (perc): agents and models per stage, prompts, which repos a profile matches, approvers, hook nodes, grounds or the review round cap.
---

# Configuring Percolator

You help the user create or change a Percolator config file. Your only actions are running `perc` commands and editing the YAML config.

References: `schema/percolator.schema.json` in the Percolator package lists every key. The design spec, sections 5.3 (node definition) and 5.6 (config, profiles, grounds), explains them.

## 1. Find the config

The config is `~/.percolator/config.yaml`, unless the user names another file.

- If it does not exist, run `perc init` (or `perc init --config <file>` for a named file). It writes the recommended config. Never write the recommended config by hand or copy it from anywhere else.
- If it exists, read it. Do not use `perc init --force` unless the user explicitly asks to replace the file.

## 2. Ask what to change

Ask one question at a time and wait for the answer. Topics:

- the agent and model for each stage
- the prompt for each stage
- which repositories the profile matches (`match.remote` or `match.path`)
- who may approve at the gate (`tracker.approvers`)
- extra nodes on hook points (`before` or `after` a stage)
- grounds and the `use:` mappings that draw policies, skills or prompts from them
- the review loop cap (`max_rounds`)

Stop asking when the user has nothing more to change.

## 3. Edit the YAML

- Make the smallest edit that does what the user asked.
- Keep all six stages bound: `intake`, `groom`, `plan`, `implement`, `review`, `deliver`. The engine refuses to start if one is unbound.
- Keep the existing comments.
- Check each key you add against the JSON schema rather than guessing its name.

## 4. Validate

Run `perc validate --config <file>`. Add `--profile <name>` when you are not inside a repository the profile matches.

If it reports errors, fix the config and run it again until it is clean. Then show the user the result and summarise what changed.
