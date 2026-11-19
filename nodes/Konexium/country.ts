import { NodeOperationError } from 'n8n-workflow';
import type { ApiContext } from './transport';

// The 54 African countries: alpha-2, alpha-3, English name, then exact aliases.
// Western Sahara names are omitted until backend support is confirmed. Alpha-2
// inputs retain the existing passthrough behaviour, including EH.
const countries: readonly (readonly string[])[] = [
  ['DZ', 'DZA', 'Algeria'],
  ['AO', 'AGO', 'Angola'],
  ['BJ', 'BEN', 'Benin'],
  ['BW', 'BWA', 'Botswana'],
  ['BF', 'BFA', 'Burkina Faso'],
  ['BI', 'BDI', 'Burundi'],
  ['CV', 'CPV', 'Cabo Verde', 'Cape Verde'],
  ['CM', 'CMR', 'Cameroon'],
  ['CF', 'CAF', 'Central African Republic'],
  ['TD', 'TCD', 'Chad'],
  ['KM', 'COM', 'Comoros'],
  ['CG', 'COG', 'Republic of the Congo', 'Republic of Congo', 'Congo-Brazzaville'],
  ['CD', 'COD', 'Democratic Republic of the Congo', 'Democratic Republic of Congo', 'DRC', 'DR Congo', 'Congo-Kinshasa'],
  ['CI', 'CIV', "Côte d'Ivoire", 'Ivory Coast'],
  ['DJ', 'DJI', 'Djibouti'],
  ['EG', 'EGY', 'Egypt'],
  ['GQ', 'GNQ', 'Equatorial Guinea'],
  ['ER', 'ERI', 'Eritrea'],
  ['SZ', 'SWZ', 'Eswatini', 'Swaziland'],
  ['ET', 'ETH', 'Ethiopia'],
  ['GA', 'GAB', 'Gabon'],
  ['GM', 'GMB', 'Gambia', 'The Gambia'],
  ['GH', 'GHA', 'Ghana'],
  ['GN', 'GIN', 'Guinea'],
  ['GW', 'GNB', 'Guinea-Bissau', 'Guinea Bissau'],
  ['KE', 'KEN', 'Kenya'],
  ['LS', 'LSO', 'Lesotho'],
  ['LR', 'LBR', 'Liberia'],
  ['LY', 'LBY', 'Libya'],
  ['MG', 'MDG', 'Madagascar'],
  ['MW', 'MWI', 'Malawi'],
  ['ML', 'MLI', 'Mali'],
  ['MR', 'MRT', 'Mauritania'],
  ['MU', 'MUS', 'Mauritius'],
  ['MA', 'MAR', 'Morocco'],
  ['MZ', 'MOZ', 'Mozambique'],
  ['NA', 'NAM', 'Namibia'],
  ['NE', 'NER', 'Niger'],
  ['NG', 'NGA', 'Nigeria'],
  ['RW', 'RWA', 'Rwanda'],
  ['ST', 'STP', 'São Tomé and Príncipe', 'Sao Tome & Principe', 'SÃ£o TomÃ© and PrÃ­ncipe'],
  ['SN', 'SEN', 'Senegal'],
  ['SC', 'SYC', 'Seychelles'],
  ['SL', 'SLE', 'Sierra Leone'],
  ['SO', 'SOM', 'Somalia'],
  ['ZA', 'ZAF', 'South Africa'],
  ['SS', 'SSD', 'South Sudan'],
  ['SD', 'SDN', 'Sudan'],
  ['TZ', 'TZA', 'Tanzania', 'United Republic of Tanzania'],
  ['TG', 'TGO', 'Togo'],
  ['TN', 'TUN', 'Tunisia'],
  ['UG', 'UGA', 'Uganda'],
  ['ZM', 'ZMB', 'Zambia'],
  ['ZW', 'ZWE', 'Zimbabwe'],
];

function countryKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[‘’]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const countryCodes = new Map<string, string>();
for (const [alpha2, ...names] of countries) {
  for (const name of names) countryCodes.set(countryKey(name), alpha2);
}

/** Resolve country names/codes once, before building API input or retry keys. */
export function normaliseCountry(context: ApiContext, value: unknown): string {
  if (typeof value === 'string') {
    const code = value.trim().toUpperCase();
    // Preserve the original validation for ALL alpha-2 inputs, African or not.
    if (/^[A-Z]{2}$/.test(code)) return code;

    const key = countryKey(value);
    if (key === 'congo') {
      throw new NodeOperationError(
        context.getNode(),
        'Country is ambiguous: Congo. Use Democratic Republic of the Congo (CD) or Republic of the Congo (CG).',
      );
    }
    const country = countryCodes.get(key);
    if (country) return country;
  }
  throw new NodeOperationError(
    context.getNode(),
    `Country not recognised: ${String(value)}. Use a country name such as Nigeria or a two-letter code such as NG.`,
  );
}
