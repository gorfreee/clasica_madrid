# Patrimonio Nacional fixtures

`listing.json` is a reduced capture of the official Drupal JSON:API response
from `https://www.patrimonionacional.es/jsonapi/node/eventos`, checked on
2026-09-14. It keeps four real event resources and the relationship resources
needed to exercise a Madrid concert, a non-musical Madrid event, a concert
outside the project geography and the two rooms currently used at Palacio Real.

Large programme and body fields, JSON:API resource links and unrelated fields
were trimmed. Tests replace only the top-level pagination links so the same
capture can cover the requested ingest window and multi-page behaviour.
