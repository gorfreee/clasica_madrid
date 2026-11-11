import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { mergeCandidateBatch, validatePublicationIntegrity } from '../src/ingestion/batch.ts';
import { canonicalizeWorkList } from '../src/ingestion/composer-name.ts';
import { parseAuditorioNacionalDetail } from '../src/ingestion/detail/auditorio-nacional.ts';
import {
  looksLikeAuditorioAdministrativeNotice,
  segmentAuditorioBlocks,
} from '../src/ingestion/detail/auditorio-segments.ts';
import { workSchema } from '../src/lib/schemas/event.ts';
import { makeCatalog, makeEvent } from './helpers.ts';

const fixtureDir = new URL('./fixtures/ingestion/auditorio-notices-20261111/', import.meta.url);
const postponementCheca = new URL(
  './fixtures/ingestion/auditorio-postponements-20261022/checa.html',
  import.meta.url,
);

const LONG_NOTICE =
  'Ante la huelga general del día 11 de noviembre, convocada por las organizaciones sindicales, este concierto podría verse afectado, en función del seguimiento de la convocatoria por parte de los trabajadores y trabajadoras del INAEM y de las empresas organizadoras de ambos conciertos. Para más información y detalles sobre la devolución del importe de las localidades en caso de cancelación total o parcial, por favor contacten con los canales de venta de cada concierto.';
const SHORT_NOTICE =
  'Ante la huelga general del día 11 de noviembre, convocada por las organizaciones sindicales, este concierto podría verse afectado, en función del seguimiento de la convocatoria por parte de los trabajadores y trabajadoras del INAEM y de las empresas organizadoras de ambos conciertos.';

const CHECA_WORKS = [
  { title: 'Concierto para piano núm. 3', composerName: 'RACHMANINOFF' },
  { title: 'Mi patria (selección) (El alto castillo/Moldava/Sarka)', composerName: 'SMETANA' },
];
const OSUCM_WORKS = [
  { title: 'To Andalusia and beyond', composerName: 'KATRINA PENMAN (1982)' },
  { title: 'Fallesca', composerName: 'JESÚS ÁNGEL LEÓN (1956)' },
  { title: 'Cántigas de Luz', composerName: 'FLORES CHAVIANO (1946)' },
  {
    title: 'Tambourine op. 13. Variaciones para orquesta sobre un tema de Rameau (2001)',
    composerName: 'ALEJANDRO ROMÁN (1971)',
  },
];

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, fixtureDir), 'utf8');
}

function titles(html: string): string[] {
  return (parseAuditorioNacionalDetail(html).works ?? []).map((work) => work.title);
}

describe('avisos administrativos del Auditorio', () => {
  it('mide los dos avisos del run 43056214891', () => {
    expect(LONG_NOTICE).toHaveLength(471);
    expect(SHORT_NOTICE).toHaveLength(284);
    expect(looksLikeAuditorioAdministrativeNotice(LONG_NOTICE)).toBe(true);
    expect(looksLikeAuditorioAdministrativeNotice(SHORT_NOTICE)).toBe(true);
    expect(looksLikeAuditorioAdministrativeNotice('Rogamos disculpen las molestias.')).toBe(true);
    expect(looksLikeAuditorioAdministrativeNotice('AVISO IMPORTANTE')).toBe(true);
  });

  it('la ficha oficial de la Filarmónica Checa conserva obras, atribuciones y elenco declarado', async () => {
    const facts = parseAuditorioNacionalDetail(await fixture('checa.html'));
    expect(facts.works).toEqual(CHECA_WORKS);
    expect(facts.performers).toEqual([
      { name: 'Filarmónica Checa' },
      { name: 'Semyon Bychkov', roleText: 'dirección' },
      { name: 'Behzod Abduraimov', roleText: 'piano' },
    ]);
    expect(facts.programText).toBe(
      'RACHMANINOFF Concierto para piano núm. 3\nSMETANA Mi patria (selección) (El alto castillo/Moldava/Sarka)',
    );
    expect(facts.occurrences).toEqual([{ raw: '2026-11-11T19:30:00+01:00', date: '2026-11-11', time: '19:30' }]);
    expect(facts.eventStatus).toBeUndefined();
    expect(titles(await fixture('checa.html')).join('\n')).not.toMatch(/huelga|disculpen|AVISO IMPORTANTE/i);
  });

  it('la ficha oficial de OSUCM conserva obras y solo la orquesta que la ficha declara', async () => {
    const facts = parseAuditorioNacionalDetail(await fixture('osucm.html'));
    expect(facts.works).toEqual(OSUCM_WORKS);
    expect(facts.performers).toEqual([
      { name: 'Orquesta Sinfónica de la Universidad Complutense de Madrid (OSUCM)' },
      { name: 'Katrina Penman', roleText: 'flauta' },
      { name: 'Gerardo López Laguna', roleText: 'piano' },
      { name: 'José Sanchís', roleText: 'director artístico y musical' },
    ]);
    expect(facts.programText).not.toMatch(/huelga|disculpen|AVISO IMPORTANTE/i);
    expect(facts.occurrences).toEqual([{ raw: '2026-11-11T19:30:00+01:00', date: '2026-11-11', time: '19:30' }]);
    expect(facts.eventStatus).toBeUndefined();
  });

  it('el aviso largo de la Checa no entra en las obras y la orquesta vuelve al elenco', async () => {
    const facts = parseAuditorioNacionalDetail(await fixture('checa-aviso-largo.html'));
    expect(facts.works).toEqual(CHECA_WORKS);
    expect(facts.performers).toEqual([
      { name: 'Filarmónica Checa' },
      { name: 'Semyon Bychkov', roleText: 'dirección' },
      { name: 'Behzod Abduraimov', roleText: 'piano' },
    ]);
    expect(facts.works?.some((work) => work.title.length > 300)).toBe(false);
    expect(facts.eventStatus).toBeUndefined();
    expect(facts.occurrences).toEqual([{ raw: '2026-11-11T19:30:00+01:00', date: '2026-11-11', time: '19:30' }]);
  });

  it('el aviso corto de OSUCM no contamina las obras ni inventa la orquesta ausente', async () => {
    const facts = parseAuditorioNacionalDetail(await fixture('osucm-aviso-corto.html'));
    expect(facts.works).toEqual(OSUCM_WORKS);
    expect(facts.performers).toEqual([
      { name: 'Katrina Penman', roleText: 'flauta' },
      { name: 'Gerardo López Laguna', roleText: 'piano' },
      { name: 'José Sanchís', roleText: 'director artístico y musical' },
    ]);
    expect(facts.performers?.some((person) => /orquesta|osucm|filarmónica/i.test(person.name))).toBe(false);
  });

  it('separa el aviso antes de interpretar el repertorio, también dentro del mismo h4', () => {
    const segments = segmentAuditorioBlocks([
      [
        'AVISO IMPORTANTE',
        LONG_NOTICE,
        'Rogamos disculpen las molestias.',
        'Filarmónica Checa',
        'Semyon Bychkov, dirección',
        'RACHMANINOFF Concierto para piano núm. 3',
      ],
    ]);
    expect(segments.noticeLines).toEqual(['AVISO IMPORTANTE', LONG_NOTICE, 'Rogamos disculpen las molestias.']);
    expect(segments.performerLines).toEqual(['Filarmónica Checa', 'Semyon Bychkov, dirección']);
    expect(segments.programLines).toEqual(['RACHMANINOFF Concierto para piano núm. 3']);
  });

  it('conserva un aplazamiento real aunque el mismo documento lleve el aviso de huelga', async () => {
    const official = await readFile(postponementCheca, 'utf8');
    const combined = official.replace(
      '<div class="content">',
      `<div class="content"><h4>AVISO IMPORTANTE<br />${SHORT_NOTICE}<br />Rogamos disculpen las molestias.</h4>`,
    );
    const facts = parseAuditorioNacionalDetail(combined);
    expect(facts.eventStatus).toBe('postponed');
    expect(facts.occurrences).toMatchObject([{ date: '2026-11-13', time: '22:30' }]);
    expect(facts.occurrences?.[0]?.raw).toContain('CONCIERTO APLAZADO');
    expect(facts.occurrences?.[0]?.raw).toContain('Ante la huelga general');
    expect(facts.works).toEqual(CHECA_WORKS);
    expect(facts.performers?.map((person) => person.name)).toContain('Filarmónica Checa');
  });

  it('no confunde agrupaciones ni títulos que comparten vocabulario con el aviso', () => {
    expect(looksLikeAuditorioAdministrativeNotice('Voces Huelgas')).toBe(false);
    expect(looksLikeAuditorioAdministrativeNotice('Filarmónica Checa')).toBe(false);
    expect(looksLikeAuditorioAdministrativeNotice('Orquesta Sinfónica de la Universidad Complutense de Madrid (OSUCM)')).toBe(false);
    expect(looksLikeAuditorioAdministrativeNotice('La huelga')).toBe(false);
    expect(looksLikeAuditorioAdministrativeNotice('Ante la huelga, op. 12')).toBe(false);
    expect(looksLikeAuditorioAdministrativeNotice(
      'Ante la huelga de los gremios, suite para cuerda y clave en la corte de Madrid',
    )).toBe(false);
    expect(looksLikeAuditorioAdministrativeNotice('Danzas filarmónicas')).toBe(false);
    expect(looksLikeAuditorioAdministrativeNotice('Aviso importante para los marineros')).toBe(false);
    expect(looksLikeAuditorioAdministrativeNotice(OSUCM_WORKS[3]!.title)).toBe(false);
    expect(looksLikeAuditorioAdministrativeNotice('CONCIERTO APLAZADO')).toBe(true);
    expect(looksLikeAuditorioAdministrativeNotice('al 13 de NOVIEMBRE, a las 22:30H')).toBe(true);

    const facts = parseAuditorioNacionalDetail(`<article><div class="content"><h4>
      Voces Huelgas<br />Sofía Alegre, viola<br />
      Anónimo<br />La huelga<br />Danzas filarmónicas<br />
      Ante la huelga, op. 12<br />
      Ante la huelga de los gremios, suite para cuerda y clave en la corte de Madrid<br />
      ALEJANDRO ROMÁN (1971) Tambourine op. 13. Variaciones para orquesta sobre un tema de Rameau (2001)
    </h4></div><div class="rightcolumn"><label class="rightColumn__item__label">Sala:</label><span class="rightColumn__item__text">Sala de Cámara</span></div></article>`);
    expect(facts.performers).toEqual([
      { name: 'Voces Huelgas' },
      { name: 'Sofía Alegre', roleText: 'viola' },
    ]);
    expect(facts.works).toEqual([
      { title: 'La huelga' },
      { title: 'Danzas filarmónicas' },
      { title: 'Ante la huelga, op. 12' },
      { title: 'Ante la huelga de los gremios, suite para cuerda y clave en la corte de Madrid' },
      {
        title: 'Tambourine op. 13. Variaciones para orquesta sobre un tema de Rameau (2001)',
        composerName: 'ALEJANDRO ROMÁN (1971)',
      },
    ]);
    expect(facts.performers?.some((person) => /orquesta/i.test(person.name))).toBe(false);
  });

  it('el error de longitud desaparece por la extracción; el control del candidato inválido sigue', async () => {
    const extracted = canonicalizeWorkList(
      parseAuditorioNacionalDetail(await fixture('checa-aviso-largo.html')).works ?? [],
    );
    expect(extracted).toEqual([
      { title: 'Concierto para piano núm. 3', composerName: 'Serguéi Rajmáninov' },
      { title: 'Mi patria (selección) (El alto castillo/Moldava/Sarka)', composerName: 'Bedřich Smetana' },
    ]);
    for (const work of extracted) expect(workSchema.safeParse(work).success).toBe(true);
    const publishedNotice = canonicalizeWorkList([{ title: LONG_NOTICE }])[0]!.title;
    expect(publishedNotice.length).toBeGreaterThan(300);
    const rejected = workSchema.safeParse({ title: publishedNotice });
    expect(rejected.success).toBe(false);
    if (rejected.success) throw new Error('el aviso no puede ser un título de obra');
    expect(rejected.error.issues[0]?.message).toMatch(/300/);

    const catalog = makeCatalog({ events: [] });
    const eventId = 'evt_auditorio_nacional_ibermusica_filarmonica_checa_2_2';
    const plan = [{ eventId, action: 'new' as const }];
    const invalid = {
      schemaVersion: 1 as const,
      event: makeEvent({
        id: eventId,
        slug: 'ibermusica-filarmonica-checa-2',
        title: 'Ibermúsica. Filarmónica Checa',
        works: [{ title: publishedNotice }],
      }),
    };
    const valid = {
      schemaVersion: 1 as const,
      event: makeEvent({
        id: eventId,
        slug: 'ibermusica-filarmonica-checa-2',
        title: 'Ibermúsica. Filarmónica Checa',
        works: extracted,
      }),
    };
    const broken = mergeCandidateBatch(catalog, [invalid], { publicationPlan: plan });
    const brokenIssues = [
      ...broken.issues,
      ...validatePublicationIntegrity(catalog, [invalid], broken.catalog, broken.filesToWrite, plan),
    ];
    expect(brokenIssues.filter((issue) => issue.code === 'schema').map((issue) => issue.message)).toEqual([
      expect.stringMatching(/event\.works\.0\.title:.*300/),
    ]);
    expect(brokenIssues.filter((issue) => issue.code === 'publication-integrity').map((issue) => issue.message)).toEqual([
      `${eventId}: decisión new sin destino persistible`,
      `${eventId}: decisión material sin candidato`,
    ]);
    expect(broken.newEvents).toBe(0);
    expect(broken.filesToWrite).toEqual([]);

    const fixed = mergeCandidateBatch(catalog, [valid], { publicationPlan: plan });
    const fixedIssues = [
      ...fixed.issues,
      ...validatePublicationIntegrity(catalog, [valid], fixed.catalog, fixed.filesToWrite, plan),
    ];
    expect(fixedIssues.filter((issue) => issue.code === 'schema' || issue.code === 'publication-integrity')).toEqual([]);
    expect(fixed.newEvents).toBe(1);
  });
});
