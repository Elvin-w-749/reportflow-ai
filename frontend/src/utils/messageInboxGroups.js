const firstText = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}

const rawTimestampOf = (message = {}) => {
  const value = Number(message.rawTs)
  return Number.isFinite(value) ? value : 0
}

const unreadCountOf = (message = {}) => {
  const count = Number(message.unreadCount)
  if (Number.isFinite(count) && count > 0) return count
  return message.read === false || message.hasUnread === true ? 1 : 0
}

const isClientScopedMessage = (message = {}) => (
  message.clientScoped === true ||
  String(message.messageKind || '').trim().toLowerCase() === 'customer-chat'
)

const clientIdentityOf = (message = {}) => {
  const contactId = firstText(message.contactId)
  const uid = firstText(message.clientUid, message.userId, message.uid, message.customerUid)
  if (uid && uid !== contactId) return { type: 'uid', value: uid }

  const clientId = firstText(message.clientId, message.customerId)
  if (clientId && clientId !== contactId) return { type: 'client', value: clientId }

  if (contactId) return { type: 'contact', value: contactId }
  return null
}

const standaloneEntry = (message, sourceIndex) => {
  const unreadCount = unreadCountOf(message)
  const id = firstText(message && message.id, message && message.messageId, message && message._id)
  return {
    kind: 'message',
    key: `message:${id || `row-${sourceIndex}`}:${sourceIndex}`,
    message,
    rawTs: rawTimestampOf(message),
    unreadCount,
    hasUnread: unreadCount > 0,
    sourceIndex
  }
}

/**
 * Builds the mixed list rendered by the message inbox.
 *
 * Customer-scoped chat messages may be collapsed into client groups. All other
 * messages remain standalone so system, debt, approval, and progress notices
 * cannot be merged merely because they contain customer-looking fields.
 */
export function buildMessageInboxEntries(messages = [], options = {}) {
  const source = Array.isArray(messages) ? messages : []
  const groupClients = options && options.groupClients === true
  if (!groupClients) {
    return source
      .map((message, index) => standaloneEntry(message, index))
      .sort((a, b) => b.rawTs - a.rawTs || a.sourceIndex - b.sourceIndex)
  }

  const groups = new Map()
  const standalone = []

  source.forEach((message, sourceIndex) => {
    if (!isClientScopedMessage(message)) {
      standalone.push(standaloneEntry(message, sourceIndex))
      return
    }

    const identity = clientIdentityOf(message)
    if (!identity) {
      standalone.push(standaloneEntry(message, sourceIndex))
      return
    }

    const key = `client:${identity.type}:${identity.value}`
    if (!groups.has(key)) {
      groups.set(key, {
        kind: 'client-group',
        key,
        identityType: identity.type,
        identityValue: identity.value,
        sourceIndex,
        messages: []
      })
    }
    groups.get(key).messages.push({ message, sourceIndex })
  })

  const clientGroups = [...groups.values()].map((group) => {
    const sortedMessages = group.messages
      .slice()
      .sort((a, b) => rawTimestampOf(b.message) - rawTimestampOf(a.message) || a.sourceIndex - b.sourceIndex)
      .map((entry) => entry.message)
    const unreadCount = sortedMessages.reduce((sum, message) => sum + unreadCountOf(message), 0)

    return {
      kind: group.kind,
      key: group.key,
      identityType: group.identityType,
      identityValue: group.identityValue,
      messages: sortedMessages,
      latestMessage: sortedMessages[0] || null,
      rawTs: sortedMessages.length ? rawTimestampOf(sortedMessages[0]) : 0,
      unreadCount,
      hasUnread: unreadCount > 0,
      sourceIndex: group.sourceIndex
    }
  })

  return [...clientGroups, ...standalone]
    .sort((a, b) => b.rawTs - a.rawTs || a.sourceIndex - b.sourceIndex)
}

export default buildMessageInboxEntries
