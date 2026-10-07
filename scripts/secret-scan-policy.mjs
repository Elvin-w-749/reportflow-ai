const STATIC_SECRET_DETECTORS = Object.freeze([
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['tencent-access-key', /\bAKID[A-Za-z0-9]{12,}\b/],
  ['prefixed-api-key', /\b(?:sk|ak)-[A-Za-z0-9_-]{20,}\b/i],
  ['credential-url', /https?:\/\/[^\s/:]+:[^\s/@]+@/i]
])

function shannonEntropy(value) {
  const source = String(value || '')
  if (!source) return 0
  const counts = new Map()
  for (const character of source) counts.set(character, (counts.get(character) || 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / source.length
    entropy -= probability * Math.log2(probability)
  }
  return entropy
}

function isHighEntropyToken(value, minimumLength = 24) {
  const source = String(value || '')
  if (source.length < minimumLength || source.length > 512) return false
  if (/\$\{|<[^>]+>|(?:example|replace|redacted|fake|test-token|local-token)/i.test(source)) return false
  const uniqueRatio = new Set(source).size / source.length
  return uniqueRatio >= 0.3 && shannonEntropy(source) >= 3.4
}

function isRandomLookingSegment(value) {
  const source = String(value || '')
  if (!isHighEntropyToken(source, 16)) return false
  const letters = [...source].filter((character) => /[A-Za-z]/.test(character))
  const upperRatio = letters.length
    ? letters.filter((character) => /[A-Z]/.test(character)).length / letters.length
    : 0
  let caseTransitions = 0
  for (let index = 1; index < letters.length; index += 1) {
    if (/[A-Z]/.test(letters[index]) !== /[A-Z]/.test(letters[index - 1])) caseTransitions += 1
  }
  const transitionRatio = letters.length > 1 ? caseTransitions / (letters.length - 1) : 0
  const digitRatio = (source.match(/\d/g) || []).length / source.length
  const vowelRatio = source.length
    ? (source.toLowerCase().match(/[aeiou]/g) || []).length / source.length
    : 0
  const lowercaseRandomProfile = /^[a-z]+$/.test(source) &&
    source.length >= 20 &&
    shannonEntropy(source) >= 3.8 &&
    new Set(source).size / source.length >= 0.45 &&
    vowelRatio >= 0.08 && vowelRatio <= 0.36
  return (upperRatio >= 0.2 && upperRatio <= 0.8 && transitionRatio >= 0.25) ||
    digitRatio >= 0.15 ||
    lowercaseRandomProfile
}

function hasCredentialContext(source, index, length) {
  const nearby = source.slice(Math.max(0, index - 160), Math.min(source.length, index + length + 40))
  return /ZHIPU_GLM_OCR_API_KEY|(?:api[_ -]?key|credential|authorization|secret)\s*[:=]?/i.test(nearby)
}

function addZhipuPairDetections(source, detections) {
  const pairPattern = /\b([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{24,128})\b/g
  let match
  while ((match = pairPattern.exec(source)) !== null) {
    const entropyValid = isHighEntropyToken(match[1], 16) && isHighEntropyToken(match[2], 24)
    const contextBound = hasCredentialContext(source, match.index, match[0].length)
    const safeBareProfile = isRandomLookingSegment(match[1]) && isRandomLookingSegment(match[2])
    if (entropyValid && (contextBound || safeBareProfile)) {
      detections.add('zhipu-id-secret')
      return
    }
  }
}

function addJwtDetections(source, detections) {
  const jwtPattern = /\b(eyJ[A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]{16,})\b/g
  let match
  while ((match = jwtPattern.exec(source)) !== null) {
    if (isHighEntropyToken(match[2], 8) && isHighEntropyToken(match[3], 16)) {
      detections.add('jwt')
      return
    }
  }
}

function addAuthorizationDetections(source, detections) {
  const headerPattern = /\bAuthorization\b\s*[:=]\s*(?:["'`]\s*)?(?:Bearer\s+)?([A-Za-z0-9._~+/=-]{24,})/gi
  let match
  while ((match = headerPattern.exec(source)) !== null) {
    if (isHighEntropyToken(match[1], 24)) {
      detections.add('authorization-high-entropy')
      return
    }
  }
}

function addCookieDetections(source, detections) {
  const cookiePattern = /\bCookie\b\s*[:=]\s*(?:["'`])?([^\r\n"'`]{1,512})/gi
  let match
  while ((match = cookiePattern.exec(source)) !== null) {
    const raw = String(match[1])
    let decoded = raw
    try { decoded = decodeURIComponent(raw) } catch (_) {}
    const candidates = [raw, decoded].flatMap((value) => value.match(/[A-Za-z0-9._~+/=-]{24,}/g) || [])
    if (candidates.some((candidate) => isHighEntropyToken(candidate, 24))) {
      detections.add('cookie-high-entropy')
      return
    }
  }
}

export function detectSecretKinds(value) {
  const source = String(value || '')
  const detections = new Set()
  for (const [name, pattern] of STATIC_SECRET_DETECTORS) {
    if (pattern.test(source)) detections.add(name)
  }
  addZhipuPairDetections(source, detections)
  addJwtDetections(source, detections)
  addAuthorizationDetections(source, detections)
  addCookieDetections(source, detections)
  return [...detections].sort()
}

export const SECRET_DETECTOR_NAMES = Object.freeze([
  ...STATIC_SECRET_DETECTORS.map(([name]) => name),
  'zhipu-id-secret',
  'jwt',
  'authorization-high-entropy',
  'cookie-high-entropy'
].sort())
