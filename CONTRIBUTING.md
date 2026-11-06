# Contributing

Bug reports, ideas and pull requests are welcome.

## Setup

There is no build step and there are no dependencies. `main.js` is the plugin.

1. Clone the repo, or symlink it, into `<vault>/.obsidian/plugins/recurra/`.
2. Run `npm run demo` for a vault with sample goals and tasks, or use your own.
3. After changing `main.js` or `styles.css`, reload the plugin (turn it off and on in Settings → Community plugins, or use the *Hot Reload* plugin).

## Tests

```sh
npm test
```

Tests run with `node --test` against a small stub of the `obsidian` module (`test/helpers.js`). They cover repeat rules, reminders, occurrence pages, links, the To Do sync and the sync-device logic. Please add a test with your change.

## Guidelines

- Keep the rules that both Google Calendar and Microsoft To Do can represent; Recurra rejects anything that would sync differently to the two.
- Sync stays one-way: Obsidian is the source of truth.
- Never log or display tokens or client secrets.
- Follow the [Obsidian plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines): no inline styles, sentence-case UI text.

## Releasing

See [Development](README.md#development) in the README.
