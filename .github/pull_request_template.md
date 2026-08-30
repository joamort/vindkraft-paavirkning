<!-- Kort: kva gjer denne PR-en, og kvifor? -->

## Endring



## Sjekkliste

- [ ] `node tools/verify_model.mjs` passerer lokalt (serveren køyrer på :8011)
- [ ] La til / oppdaterte ein test viss endringa rører modellen (`js/utils/*.js`)
- [ ] Endra eg tryggingsheader / CSP / tilgangskontroll? Då er **både**
      `.htaccess` og `Caddyfile` oppdaterte, og `CONFIG-VERSION` i `.htaccess`
      er bumpa
- [ ] Ingen inline `<script>` / `onclick=` — interaksjon går via `data-action`
- [ ] Nye asynkrone knappar sperrar seg sjølv medan dei køyrer (flagg + disabled
      + tilbakemelding)
- [ ] Brukarens valde punkt vert ikkje sendt eller logga nokon stad (PLAN.md §8)
- [ ] Nye ikkje-opplagde modellval er grunngjevne i `CLAUDE.md`

## Testa



<!-- Skjermbilete er fint for UI-endringar. -->
