# Residencia de Estudiantes — API fixtures

Captured directly from the official JSON API on **2026-10-22**, without catalogue data or LLM reconstruction:

- `una-ultima-sesion.json`: full, unmodified response from <https://residenciadeestudiantes.com/api/wp-json/front/data/get_event_data?slug=una-ultima-sesion-joaquin-nin-castellanos-en-el-auditorium-de-la-residencia-de-estudiantes>, ID **32261**. SHA-256: `d951264508270c512a0837a286b9cdc2216966143a8dc0c0a967a175bafc012d`.
- `ecce-finem.json`: full, unmodified response from <https://residenciadeestudiantes.com/api/wp-json/front/data/get_event_data?slug=ecce-finem>, ID **32405**. SHA-256: `da7e70b6b9892c7575fa964aa120e24d75bc28d4dcfa3065fed9da4d74a60c17`.
- `listing-sessions.json`: response from <https://residenciadeestudiantes.com/api/wp-json/front/data/get_events_page>, **reduced** to those two actual `active_events`; only the four listing fields required by the adapter retained; thumbnail objects and unrelated activities removed; the other two event arrays set to `false`. This isolated test input is not evidence of complete listing coverage. The live response contained 22 main events and 5 ILE events and continues to trigger the existing limited-listing diagnostic.

The two detail responses reproduce the manual corrections documented in PR #384. They include unrelated people in biographies, reservation/itinerary times and end times intentionally, to check that those do not become performance credits or sessions.

Programme extraction requires an attributed paragraph with a composer heading and explicit line boundaries. Movements remain with the parent work in the original `programText`; repeated parent titles are deduplicated. Independent italic titles joined by `y` in the same attributed line are separated. Prose or paragraphs without a safe attribution stay as text. No generic prose parser, new venue aliases or expanded listing coverage are introduced.

`detail.json` and `listing.json` predate these regressions and retain the original adapter tests.
