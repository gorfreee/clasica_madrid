import { describe, expect, it } from 'vitest';
import { explicitAccessText } from '../src/ingestion/detail/access-evidence.ts';
import { resolveAccess } from '../src/ingestion/classification/access.ts';

describe('explicitAccessText', () => {
  it('conserva precios y frases de gratuidad observadas', () => {
    expect(explicitAccessText('Desde 12 €')).toBe('Desde 12 €');
    expect(explicitAccessText('Precio: 18 €')).toBe('Precio: 18 €');
    expect(explicitAccessText('Entrada gratuita')).toBe('Entrada gratuita');
    expect(explicitAccessText('Acceso libre')).toBe('Acceso libre');
    expect(explicitAccessText('Entrada libre hasta completar aforo')).toBe(
      'Entrada libre hasta completar aforo',
    );
    expect(explicitAccessText('Gratuito con reserva previa')).toBe('Gratuito con reserva previa');
    expect(resolveAccess(explicitAccessText('Desde 12 €')).value).toBe('paid');
    expect(resolveAccess(explicitAccessText('Gratuito con reserva previa')).value).toBe('free');
  });

  it('rechaza CTAs, taquillas y prosa sin precio ni gratuidad', () => {
    expect(explicitAccessText('Comprar')).toBeUndefined();
    expect(explicitAccessText('Entradas')).toBeUndefined();
    expect(explicitAccessText('Reservar')).toBeUndefined();
    expect(explicitAccessText('Compra la entrada')).toBeUndefined();
    expect(explicitAccessText('Compra tus entradas')).toBeUndefined();
    expect(explicitAccessText('Tickets')).toBeUndefined();
    expect(explicitAccessText('Taquilla del teatro')).toBeUndefined();
    expect(explicitAccessText('Próximamente, más información sobre horario y precio.')).toBeUndefined();
    expect(explicitAccessText('Abonos A')).toBeUndefined();
    expect(explicitAccessText(undefined)).toBeUndefined();
    expect(resolveAccess(explicitAccessText('Tickets')).value).toBe('unknown');
  });
});
