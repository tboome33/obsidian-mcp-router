## Workspace-bound path disambiguation — NEVER mix cwd path with vault subpath

Cette convention s'applique aux **sessions Claude Code en mode workspace-bound** sur ce vault (cwd = projet code/dev associé via `OBSIDIAN_ROUTER_DEFAULT_VAULT`). Elle existe parce que **le cwd et le vault ont souvent le même basename** (exemple : workspace `<...>/DEDIBOX` ↔ vault `<...>/DEDIBOX`) et concaténer le path du cwd avec un sous-chemin qui n'existe QUE dans le vault (`wiki/`, `wiki-meta/`) produit un path filesystem inexistant.

### Le piège typique

```
Workspace cwd  : <parent-cwd>/<NAME>           ← repo code/dev
Vault root     : <parent-vault>/<NAME>          ← Obsidian notes
                          ↑↑↑↑↑↑↑
                          Même basename sous deux parents différents.

❌ INCORRECT : <parent-cwd>/<NAME>/wiki/Stack/host.md
               (mix : cwd + sous-chemin qui n'existe QUE dans le vault → 404)
✅ CORRECT   : <parent-vault>/<NAME>/wiki/Stack/host.md
               (vrai path absolu du fichier dans le vault)
```

### Procédure mentale obligatoire avant de générer un path absolu

1. **Identifier le scope** : ce fichier appartient au **vault** (notes Obsidian) ou au **repo code** (workspace cwd) ?
2. **Si vault** → préfixe la racine du vault telle que retournée par `mcp__obsidian-router__list_vaults` (champ `path`), PUIS le sous-chemin `wiki/...` ou `wiki-meta/...`. JAMAIS préfixer avec le cwd.
3. **Si repo code** → préfixe le cwd, et ne pas mettre de sous-dossier `wiki/` ou `wiki-meta/` (qui n'existent que dans le vault).
4. **Dans le doute, NE PAS générer le path filesystem** → préférer dans cet ordre :
   - **Wikilink Obsidian** `[[basename]]` (résolu par basename à travers le vault, survit aux renames)
   - **Lien click-to-open** `[label](http://127.0.0.1:<insecurePort>/open/<url-encoded-vault-relative-path>)`
   - Path filesystem uniquement si explicitement demandé ET après vérification stricte

### Anti-patterns

- ❌ Concaténer naïvement `${cwd}` + `/wiki/...` ou `${cwd}\wiki\...` quand le cwd est un repo code/dev
- ❌ Confondre "le workspace s'appelle X" avec "le vault est dans le workspace" — ils peuvent vivre à des endroits totalement différents
- ❌ Générer un path filesystem absolu avant d'avoir vérifié laquelle des 2 racines est la bonne
- ❌ Mélanger `/` et `\` dans le même path (techniquement valide sous Windows mais visuellement louche → souvent symptôme d'une concaténation foireuse)
- ❌ Ignorer le bloc PATH RESOLUTION RULES injecté par le hook `wiki-query-first-nudge` au prompt-submit

### Mécanisme déterministe

Le hook `hooks/wiki-query-first-nudge.mjs` (v0.10.2+) injecte automatiquement à chaque prompt en mode workspace-bound un bloc `PATH RESOLUTION RULES` qui contient :
- Les 2 racines absolues réelles résolues dynamiquement (cwd path + vault path)
- L'exemple WRONG/RIGHT avec les vrais paths du contexte courant
- L'ordre de préférence (wikilink → click-to-open → filesystem)

Cette convention sert de doublon visible dans le `CLAUDE.md` du vault pour les contributeurs qui ouvriraient ce vault sans avoir le hook actif. Une copie est aussi dans le global `~/.claude/CLAUDE.md` de l'utilisateur principal pour application par défaut à toutes les sessions.

### Source

Convention shippée en v0.10.2 du router (2026-05-23) à la demande explicite de Roland après *"avant tu m'as créé ce lien : `C:\Users\rolan\DEDIBOX/Stack/host.md` !!!!!!! lui c'est de la merde"* puis *"c'est insupportable que tu ignores des regles, je ne veux plus que ça arrive, trouve moi une solution perenne pour tous les vaults"*. La même règle vit aussi dans le `~/.claude/CLAUDE.md` global de l'user (section "Workspace-bound path disambiguation") et est injectée déterministiquement par le hook au prompt-submit.
