import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildMessageInboxEntries } from '../src/utils/messageInboxGroups.js'

describe('message inbox client groups', () => {
  it('groups customer chats by UID before differing client ids', () => {
    const entries = buildMessageInboxEntries([
      {
        id: 'chat-old',
        messageKind: 'customer-chat',
        clientUid: 'uid-a',
        clientId: 'legacy-a',
        contactId: 'contact-a',
        rawTs: 100,
        read: true
      },
      {
        id: 'chat-new',
        clientScoped: true,
        clientUid: 'uid-a',
        clientId: 'legacy-b',
        contactId: 'contact-b',
        rawTs: 300,
        read: false
      }
    ], { groupClients: true })

    assert.equal(entries.length, 1)
    assert.equal(entries[0].kind, 'client-group')
    assert.equal(entries[0].key, 'client:uid:uid-a')
    assert.deepEqual(entries[0].messages.map((message) => message.id), ['chat-new', 'chat-old'])
  })

  it('does not merge different UIDs that reuse the same client id', () => {
    const entries = buildMessageInboxEntries([
      { id: 'chat-a', clientScoped: true, clientUid: 'uid-a', clientId: 'reused-client', contactId: 'contact-a', rawTs: 100 },
      { id: 'chat-b', clientScoped: true, clientUid: 'uid-b', clientId: 'reused-client', contactId: 'contact-b', rawTs: 200 }
    ], { groupClients: true })

    assert.equal(entries.length, 2)
    assert.deepEqual(entries.map((entry) => entry.key), ['client:uid:uid-b', 'client:uid:uid-a'])
    assert.ok(entries.every((entry) => entry.messages.length === 1))
  })

  it('keeps unidentified clients separate without using names or phone numbers', () => {
    const entries = buildMessageInboxEntries([
      {
        id: 'chat-contact-a',
        clientScoped: true,
        contactId: 'contact-a',
        clientName: '同名客户',
        phone: '138****0000',
        rawTs: 100
      },
      {
        id: 'chat-contact-b',
        clientScoped: true,
        contactId: 'contact-b',
        clientName: '同名客户',
        phone: '138****0000',
        rawTs: 200
      },
      {
        id: 'chat-no-identity-a',
        clientScoped: true,
        clientName: '同名客户',
        phone: '138****0000',
        rawTs: 300
      },
      {
        id: 'chat-no-identity-b',
        clientScoped: true,
        clientName: '同名客户',
        phone: '138****0000',
        rawTs: 400
      }
    ], { groupClients: true })

    assert.equal(entries.length, 4)
    assert.deepEqual(
      entries.filter((entry) => entry.kind === 'client-group').map((entry) => entry.key).sort(),
      ['client:contact:contact-a', 'client:contact:contact-b']
    )
    assert.deepEqual(
      entries.filter((entry) => entry.kind === 'message').map((entry) => entry.message.id).sort(),
      ['chat-no-identity-a', 'chat-no-identity-b']
    )
  })

  it('keeps system, debt, and consultation progress messages standalone', () => {
    const entries = buildMessageInboxEntries([
      {
        id: 'chat',
        messageKind: 'customer-chat',
        clientUid: 'uid-a',
        contactId: 'contact-a',
        rawTs: 100
      },
      {
        id: 'system',
        category: 'system',
        clientUid: 'uid-a',
        contactId: 'contact-a',
        rawTs: 400
      },
      {
        id: 'debt',
        category: 'advisor',
        debt: true,
        clientUid: 'uid-a',
        contactId: 'contact-a',
        rawTs: 300
      },
      {
        id: 'consultation-progress',
        category: 'consultation',
        focus: 'materials',
        clientUid: 'uid-a',
        contactId: 'contact-a',
        rawTs: 200
      }
    ], { groupClients: true })

    const clientGroups = entries.filter((entry) => entry.kind === 'client-group')
    const standaloneIds = entries
      .filter((entry) => entry.kind === 'message')
      .map((entry) => entry.message.id)

    assert.equal(clientGroups.length, 1)
    assert.deepEqual(clientGroups[0].messages.map((message) => message.id), ['chat'])
    assert.deepEqual(standaloneIds, ['system', 'debt', 'consultation-progress'])
  })

  it('sorts groups and messages by rawTs and aggregates unread counts', () => {
    const entries = buildMessageInboxEntries([
      {
        id: 'client-a-old',
        clientScoped: true,
        clientUid: 'uid-a',
        rawTs: 100,
        unreadCount: 2,
        read: false
      },
      {
        id: 'client-b',
        clientScoped: true,
        clientUid: 'uid-b',
        rawTs: 200,
        unreadCount: 0,
        read: true
      },
      {
        id: 'client-a-new',
        clientScoped: true,
        clientUid: 'uid-a',
        rawTs: 300,
        unreadCount: 0,
        read: false
      },
      {
        id: 'standalone-newest',
        category: 'system',
        rawTs: 400,
        unreadCount: 4,
        read: true
      }
    ], { groupClients: true })

    assert.deepEqual(entries.map((entry) => entry.key), [
      'message:standalone-newest:3',
      'client:uid:uid-a',
      'client:uid:uid-b'
    ])
    assert.deepEqual(entries[1].messages.map((message) => message.id), ['client-a-new', 'client-a-old'])
    assert.equal(entries[1].unreadCount, 3)
    assert.equal(entries[1].hasUnread, true)
    assert.equal(entries[2].unreadCount, 0)
    assert.equal(entries[2].hasUnread, false)
    assert.equal(entries[0].unreadCount, 4)
  })

  it('leaves every message standalone when client grouping is disabled', () => {
    const entries = buildMessageInboxEntries([
      { id: 'chat-a', messageKind: 'customer-chat', clientUid: 'uid-a', rawTs: 100 },
      { id: 'chat-b', messageKind: 'customer-chat', clientUid: 'uid-a', rawTs: 200 }
    ], { groupClients: false })

    assert.equal(entries.length, 2)
    assert.ok(entries.every((entry) => entry.kind === 'message'))
    assert.deepEqual(entries.map((entry) => entry.message.id), ['chat-b', 'chat-a'])
  })
})
