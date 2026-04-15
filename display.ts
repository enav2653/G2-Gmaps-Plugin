const MAX_INSTR = 35

export function formatInstruction(text: string, maxLen = MAX_INSTR): string {
  const stripped = text
    .replace(/\n.*/s, '')          // drop supplementary notes (e.g. "Restricted usage road")
    .replace(/\s+towards?\s+.+$/i, '')
  const abbr = stripped
    .replace(/\bStreet\b/g,    'St')
    .replace(/\bAvenue\b/g,    'Ave')
    .replace(/\bBoulevard\b/g, 'Blvd')
    .replace(/\bDrive\b/g,     'Dr')
    .replace(/\bLane\b/g,      'Ln')
    .replace(/\bRoad\b/g,      'Rd')
    .replace(/\bHighway\b/g,   'Hwy')
    .replace(/\bNorthwest\b/g, 'NW').replace(/\bNortheast\b/g, 'NE')
    .replace(/\bSouthwest\b/g, 'SW').replace(/\bSoutheast\b/g, 'SE')
    .replace(/\bNorth\b/g, 'N').replace(/\bSouth\b/g, 'S')
    .replace(/\bEast\b/g,  'E').replace(/\bWest\b/g,   'W')

  return abbr.length <= maxLen ? abbr : abbr.slice(0, maxLen - 1) + '…'
}

export function formatDistance(meters: number): string {
  const feet = meters * 3.28084
  if (feet < 500) return `${Math.round(feet / 10) * 10} ft`
  const miles = meters / 1609.34
  return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`
}

export function formatETA(seconds: number): string {
  if (seconds < 60) return '<1 min'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60), m = minutes % 60
  return m > 0 ? `${h} hr ${m} min` : `${h} hr`
}

export function formatClockTime(date: Date = new Date()): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
