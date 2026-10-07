export const REQUIRED_ANALYZE_CONTRACT = Object.freeze([
  ['meta', 'object'],
  ['assessment', 'object'],
  ['credit_debt', 'object'],
  ['credit_debt.credit_loans', 'object'],
  ['credit_debt.credit_cards', 'object'],
  ['loan_details', 'object'],
  ['loan_details.bank_loans', 'array'],
  ['loan_details.non_bank_loans', 'array'],
  ['credit_card_details', 'array'],
  ['overdue_info', 'object'],
  ['overdue_info.details', 'array'],
  ['query_analysis', 'object'],
  ['query_analysis.query_details', 'array'],
  ['query_analysis.summary', 'object'],
  ['public_records', 'object'],
  ['risk_analysis', 'object'],
  ['risk_analysis.risk_hits', 'array'],
  ['rule_engine_warnings', 'array'],
  ['frontend_payload', 'object'],
  ['data_completeness', 'object']
])

const getPath = (value, path) => path.split('.').reduce((current, part) => (
  current && typeof current === 'object' ? current[part] : undefined
), value)

const valueType = (value) => {
  if (Array.isArray(value)) return 'array'
  if (value && typeof value === 'object') return 'object'
  return typeof value
}

export const validAnalyzeData = (data) => data
  && typeof data === 'object'
  && !Array.isArray(data)
  && REQUIRED_ANALYZE_CONTRACT.every(([path, expectedType]) => (
    valueType(getPath(data, path)) === expectedType
  ))

export const classifyTransportError = ({ status, code, message, timedOut = false }) => {
  if (timedOut) return 'timeout'
  if (status === 401 || code === 401) return 'auth'
  if (status === 413 || code === 413) return 'upload_too_large'
  if (status === 429 || code === 4029) return 'rate_limit'
  if (/OCR|识别|漏页|漏读/.test(message || '')) return 'ocr_incomplete'
  if (/DeepSeek|非 JSON|token|context/i.test(message || '')) return 'model_response'
  if (status >= 500) return 'server_5xx'
  if (status >= 400 || (typeof code === 'number' && code !== 0)) return 'business_error'
  return 'network_or_unknown'
}

export const classifyAnalyzeFailure = ({
  responseTargetOk,
  status,
  code,
  payloadParsed,
  data,
  message
}) => {
  if (!responseTargetOk) return 'response_target_mismatch'
  // A 200 response is expected to follow the old analyze contract. A non-JSON
  // body, missing numeric code, or code=0 without a populated data object is a
  // model/contract failure and must stop the batch instead of being retried.
  if (status === 200 && (
    payloadParsed !== true
    || typeof code !== 'number'
    || (code === 0 && !validAnalyzeData(data))
  )) return 'model_response'
  return classifyTransportError({ status, code, message })
}
