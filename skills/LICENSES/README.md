# Third-party skills

Skills copied into this folder keep their authors' licenses. Their text is unchanged, except one frontmatter line,
`disable-model-invocation: true`, which keeps them out of the model's automatic skill list: Faro loads them only when
the plan or the user names them.

| Skills | Source | Commit | License |
| --- | --- | --- | --- |
| Every skill marked "Addy" in `catalog.json`, and `../references/` | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | `aeac41d4d005999432bb7312f7ff06383a91d59d` | MIT, [addyosmani-agent-skills.txt](addyosmani-agent-skills.txt) |
| `grilling`, `handoff` | [mattpocock/skills](https://github.com/mattpocock/skills) | `5beb35b040e3de97e54fa9e386d7e42d15c295c2` | MIT, [mattpocock-skills.txt](mattpocock-skills.txt) |

Impeccable ([pbakaus/impeccable](https://github.com/pbakaus/impeccable), Apache-2.0, by Paul Bakaus) is not copied:
it ships a binary and installs itself into a project with `npx impeccable install`.

To update: copy the folders from a newer commit of the source, run `npm run skills`, and update the
commit above.
