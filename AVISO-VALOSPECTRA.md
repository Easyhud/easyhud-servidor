# Aviso: código adaptado de ValoSpectra

Esta rama (`copia-funcional`) incluye código **adaptado** del proyecto ValoSpectra
(https://github.com/ValoSpectra/Spectra-Server), publicado bajo la licencia **Elastic License 2.0 (ELv2)**.
El texto de esa licencia está en `licencias-terceros/ValoSpectra-Spectra-Server-LICENSE.md`.

**Qué implica:** Se puede usar, copiar y modificar, pero NO ofrecer el resultado como servicio gestionado a terceros, ni saltarse o quitar funciones protegidas por clave de licencia, ni quitar los avisos de licencia y copyright.

Cada trozo adaptado lleva sobre él un comentario `Adaptado de ValoSpectra/Spectra-Server (...)` con el fichero de origen.
Los ficheros que contienen código adaptado en esta rama son:

- `src/partida/reductor.ts`
- `src/partida/saneado.ts`
- `src/partida/serializa.ts`
- `src/partida/tablas.ts`
- `src/partida/tipos.ts`
- `test/copia-funcional.test.ts`
- `test/segunda-pasada.test.ts`
- `test/segunda-pasada-red.test.ts`

La línea `testing` / `master` de este repositorio NO incluye este código (se escribió en sala limpia); esta rama no se
debe mezclar con ellas sin resolver antes las licencias. Uso actual: propio, en torneos propios, sin venta.