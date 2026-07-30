import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')
const config = JSON.parse(
  await readFile(new URL('../../config.json', import.meta.url), 'utf8')
)
const schema = JSON.parse(
  await readFile(new URL('../../storage/schema.json', import.meta.url), 'utf8')
)
const bestOfFiveMigration = JSON.parse(
  await readFile(
    new URL('../../storage/migrations/0003_best_of_five.json', import.meta.url),
    'utf8'
  )
)
const transformed = source
  .replace(/^import .*\n\n/, '')
  .replace(/^export function /gm, 'function ')
  .concat(`
    return {
      getPokerSettings, savePokerSettings, createPokerGame, listPokerGames,
      deletePokerGame, getPublicPokerGame, joinPokerGame, recordPokerPayment,
      drawPokerCards, foldPokerGame, startNextPokerHand,
      settlePlayerPokerPayout, settlePokerGame,
      settlePayouts, evaluateHand, compareScores, shuffledDeck, sha256
    }
  `)

function createHarness() {
  const tables = new Map()
  const payments = []
  let now = 1700000000
  let id = 0
  const storage = {
    get(table, recordId, fallback = null) {
      return tables.get(table)?.get(recordId) ?? fallback
    },
    set(table, data) {
      if (!tables.has(table)) tables.set(table, new Map())
      tables.get(table).set(data.id, structuredClone(data))
      return data
    },
    compareAndSet(table, recordId, expected, updates) {
      const row = tables.get(table)?.get(recordId)
      if (!row) return false
      if (!Object.entries(expected).every(([key, value]) => row[key] === value)) {
        return false
      }
      tables.get(table).set(recordId, structuredClone({...row, ...updates}))
      return true
    },
    delete(table, recordId) {
      tables.get(table)?.delete(recordId)
    },
    getPaginated(table, options = {}) {
      let rows = [...(tables.get(table)?.values() || [])]
      for (const [key, value] of Object.entries(options.filters || {})) {
        rows = rows.filter(row => row[key] === value)
      }
      if (options.search) {
        const query = options.search.toLowerCase()
        rows = rows.filter(row =>
          (options.searchFields || []).some(field =>
            String(row[field] || '').toLowerCase().includes(query)
          )
        )
      }
      if (options.sortBy) {
        rows.sort((a, b) => {
          const result = a[options.sortBy] > b[options.sortBy]
            ? 1
            : a[options.sortBy] < b[options.sortBy]
              ? -1
              : 0
          return options.descending ? -result : result
        })
      }
      return {
        data: structuredClone(rows.slice(options.offset || 0, (options.offset || 0) + (options.limit || 25))),
        total: rows.length
      }
    }
  }
  const wallet = {
    listUserWallets: () => [{id: 'wallet-1', name: 'Poker Bank'}],
    createInvoicePublic: ({extra}) => ({
      paymentHash: `hash-${extra.ln_address}`,
      paymentRequest: `lnbc-${extra.ln_address}`,
      checkingId: `check-${extra.ln_address}`
    }),
    payLnurl: request => {
      payments.push(structuredClone({...request, maxSat: Number(request.maxSat)}))
      const outcome = wallet.outcomes.shift()
      const response = outcome || {
        ok: true,
        status: 'success',
        success: true,
        pending: false,
        paymentHash: `paid-${payments.length}`
      }
      if (response.paymentHash) {
        wallet.paymentStatuses.set(response.paymentHash, {
          found: true,
          failed: response.status === 'failed',
          ...response
        })
      }
      return response
    },
    paymentStatus: ({paymentHash}) =>
      wallet.paymentStatuses.get(paymentHash) || {found: false},
    paymentStatuses: new Map(),
    outcomes: []
  }
  const system = {
    id: prefix => `${prefix}-${++id}`,
    now: () => ++now,
    log: () => ({ok: true})
  }
  const websocket = {publish: () => true}
  const api = new Function('storage', 'system', 'utils', 'wallet', 'websocket', transformed)(
    storage,
    system,
    {},
    wallet,
    websocket
  )
  return {api, storage, tables, wallet, payments}
}

function call(fn, payload = {}) {
  const response = JSON.parse(fn(JSON.stringify(payload)))
  if (!response.ok) throw new Error(response.error)
  return response.data
}

function failed(fn, payload = {}) {
  const response = JSON.parse(fn(JSON.stringify(payload)))
  assert.equal(response.ok, false)
  return response.error
}

function pay(api, gameId, paymentHash, lnAddress, amount = 100000) {
  return call(api.recordPokerPayment, {
    paymentHash,
    amount,
    extra: {game_id: gameId, ln_address: lnAddress}
  })
}

{
  const exports = new Set(config.wasm.exports.map(item => item.name))
  assert(config.api_routes.every(route => exports.has(route.export)))
  assert(
    config.api_routes
      .filter(route => route.auth === 'public')
      .every(route => route.ownerContext?.table === 'poker_games')
  )
  assert(!config.permissions.some(permission => permission.id === 'ext.storage.read_public'))
  assert(!JSON.stringify(config.permissions).includes('poker_secrets'))
  const gameFields = new Set(
    schema.tables.poker_games.fields.map(field => field.name)
  )
  const actionFields = new Set(
    schema.tables.poker_actions.fields.map(field => field.name)
  )
  assert.deepEqual(
    new Set(
      bestOfFiveMigration.operations
        .filter(operation => operation.table === 'poker_games')
        .map(operation => operation.field)
    ),
    new Set([
      'match_target',
      'hand_number',
      'player1_score',
      'player2_score'
    ])
  )
  assert(
    ['match_target', 'hand_number', 'player1_score', 'player2_score'].every(
      field => gameFields.has(field)
    )
  )
  assert(actionFields.has('hand_number'))
}

{
  const {api} = createHarness()
  assert.deepEqual(api.evaluateHand(['AS', 'KS', 'QS', 'JS', 'TS']).score, [8, 14])
  assert.equal(api.evaluateHand(['AS', '2H', '3D', '4C', '5S']).label, 'Five-high straight')
  assert.deepEqual(api.evaluateHand(['9S', '9H', '9D', '9C', 'AS']).score, [7, 9, 14])
  assert.equal(api.evaluateHand(['AH', 'AD', 'KC', 'QS', '2D']).label, 'Pair of Aces')
  assert.equal(
    api.sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  )
  assert(api.compareScores(
    api.evaluateHand(['AH', 'AD', 'KC', 'QS', '2D']).score,
    api.evaluateHand(['KH', 'KD', 'AC', 'QS', '2D']).score
  ) > 0)
  assert(api.compareScores(
    api.evaluateHand(['AS', '2H', '3D', '4C', '5S']).score,
    api.evaluateHand(['2S', '3H', '4D', '5C', '6S']).score
  ) < 0)
  assert(api.compareScores(
    api.evaluateHand(['AH', 'AD', 'KC', 'KS', 'QD']).score,
    api.evaluateHand(['AS', 'AC', 'KH', 'KD', 'JD']).score
  ) > 0)
  assert.equal(
    api.compareScores(
      api.evaluateHand(['AH', 'KD', 'QS', 'JC', '9H']).score,
      api.evaluateHand(['AS', 'KC', 'QH', 'JD', '9S']).score
    ),
    0
  )
  const deck = api.shuffledDeck('fixed-seed')
  assert.equal(deck.length, 52)
  assert.equal(new Set(deck).size, 52)
  assert.deepEqual(deck, api.shuffledDeck('fixed-seed'))
  assert.notDeepEqual(deck, api.shuffledDeck('another-seed'))
}

{
  const {api, tables, payments} = createHarness()
  call(api.savePokerSettings, {
    enabled: true,
    walletId: 'wallet-1',
    walletName: 'Poker Bank',
    haircut: 5
  })
  const created = call(api.createPokerGame, {
    id: 'game-flow',
    name: 'Test table',
    joinAmount: 100,
    matchTarget: 1
  })
  assert.equal(created.game.status, 'waiting')
  assert.equal(created.game.deckCommitment, api.sha256('deck-1:seed-2'))
  assert.equal(JSON.parse(tables.get('poker_secrets').get('game-flow').deck_json).length, 52)
  assert.match(
    failed(api.createPokerGame, {id: 'game-flow', joinAmount: 100}),
    /already exists/
  )

  pay(api, 'game-flow', 'token-one', 'one@example.com')
  assert.match(
    failed(api.deletePokerGame, {gameId: 'game-flow'}),
    /funded Poker game/
  )
  let view = call(api.getPublicPokerGame, {gameId: 'game-flow', playerToken: 'token-one'})
  assert.equal(view.player.seat, 'player1')
  assert.equal(view.hand.length, 0)

  pay(api, 'game-flow', 'token-two', 'two@example.com')
  view = call(api.getPublicPokerGame, {gameId: 'game-flow', playerToken: 'token-one'})
  assert.equal(view.game.status, 'active')
  assert.equal(view.game.winnerPayout, 190)
  assert.equal(view.hand.length, 5)
  assert(view.hand.every(card => card.code && card.hidden === false))
  assert(view.opponentHand.every(card => card.hidden && !card.code))
  const secondView = call(api.getPublicPokerGame, {
    gameId: 'game-flow',
    playerToken: 'token-two'
  })
  assert(secondView.hand.every(card => card.code && !card.hidden))
  assert(secondView.opponentHand.every(card => card.hidden && !card.code))
  const spectatorView = call(api.getPublicPokerGame, {gameId: 'game-flow'})
  assert(spectatorView.player1Hand.every(card => card.hidden && !card.code))
  assert(spectatorView.player2Hand.every(card => card.hidden && !card.code))

  assert.match(
    failed(api.drawPokerCards, {
      gameId: 'game-flow',
      playerToken: 'token-two',
      discardIndices: []
    }),
    /Player 1/
  )
  assert.match(
    failed(api.drawPokerCards, {
      gameId: 'game-flow',
      playerToken: 'token-one',
      discardIndices: [0, 1, 2, 3]
    }),
    /at most 3/
  )
  assert.match(
    failed(api.drawPokerCards, {
      gameId: 'game-flow',
      playerToken: 'token-one',
      discardIndices: ['0']
    }),
    /integers/
  )
  assert.match(
    failed(api.drawPokerCards, {
      gameId: 'game-flow',
      playerToken: 'not-a-player',
      discardIndices: []
    }),
    /paid player token/
  )

  call(api.drawPokerCards, {
    gameId: 'game-flow',
    playerToken: 'token-one',
    discardIndices: [0, 2]
  })
  const finished = call(api.drawPokerCards, {
    gameId: 'game-flow',
    playerToken: 'token-two',
    discardIndices: []
  })
  assert(['completed', 'draw'].includes(finished.game.status))
  assert.equal(finished.game.revealedSeed, 'deck-1:seed-2')
  view = call(api.getPublicPokerGame, {gameId: 'game-flow'})
  assert(view.player1Hand.every(card => card.code))
  assert(view.player2Hand.every(card => card.code))
  assert.equal(
    new Set([...view.player1Hand, ...view.player2Hand].map(card => card.code)).size,
    10
  )
  assert.equal(api.sha256(view.game.revealedSeed), view.game.deckCommitment)
  assert.equal(view.actions.length, 3)

  const settlement = call(api.settlePlayerPokerPayout, {
    gameId: 'game-flow',
    playerToken: 'token-one'
  })
  assert.equal(settlement.payout.ok, true)
  assert.equal(settlement.game.payoutPending, false)
  assert(payments.length === 1 || payments.length === 2)
  const paymentCount = payments.length
  const again = call(api.settlePlayerPokerPayout, {
    gameId: 'game-flow',
    playerToken: 'token-two'
  })
  assert.equal(again.payout.alreadySettled, true)
  assert.equal(payments.length, paymentCount)
}

{
  const {api, payments} = createHarness()
  call(api.savePokerSettings, {enabled: true, walletId: 'wallet-1', haircut: 0})
  call(api.createPokerGame, {
    id: 'fold-game',
    joinAmount: 100,
    matchTarget: 1
  })
  pay(api, 'fold-game', 'fold-one', 'one@example.com')
  pay(api, 'fold-game', 'fold-two', 'two@example.com')
  assert.match(
    failed(api.foldPokerGame, {
      gameId: 'fold-game',
      playerToken: 'fold-two'
    }),
    /Player 1/
  )
  const folded = call(api.foldPokerGame, {
    gameId: 'fold-game',
    playerToken: 'fold-one'
  })
  assert.equal(folded.game.winnerSeat, 'player2')
  assert.equal(folded.game.resultLabel, 'Player 1 folded')
  const view = call(api.getPublicPokerGame, {gameId: 'fold-game'})
  assert(view.player1Hand.every(card => card.code))
  assert(view.player2Hand.every(card => card.code))
  call(api.settlePokerGame, {gameId: 'fold-game'})
  assert.equal(payments.length, 1)
  assert.equal(payments[0].lnurl, 'two@example.com')
  assert.equal(payments[0].amount, 200)
  assert.equal(call(api.deletePokerGame, {gameId: 'fold-game'}).deleted, true)
}

{
  const {api, tables, payments} = createHarness()
  call(api.savePokerSettings, {enabled: true, walletId: 'wallet-1', haircut: 5})
  call(api.createPokerGame, {
    id: 'known-winner',
    joinAmount: 100,
    matchTarget: 1
  })
  pay(api, 'known-winner', 'winner-one', 'one@example.com')
  pay(api, 'known-winner', 'winner-two', 'two@example.com')
  const secrets = tables.get('poker_secrets').get('known-winner')
  tables.get('poker_secrets').set('known-winner', {
    ...secrets,
    player1_hand_json: JSON.stringify(['AS', 'KS', 'QS', 'JS', 'TS']),
    player2_hand_json: JSON.stringify(['9H', '9D', '9C', '9S', '2D'])
  })
  call(api.drawPokerCards, {
    gameId: 'known-winner',
    playerToken: 'winner-one',
    discardIndices: []
  })
  assert.match(
    failed(api.drawPokerCards, {
      gameId: 'known-winner',
      playerToken: 'winner-one',
      discardIndices: []
    }),
    /Player 2/
  )
  const showdown = call(api.drawPokerCards, {
    gameId: 'known-winner',
    playerToken: 'winner-two',
    discardIndices: []
  })
  assert.equal(showdown.game.winnerSeat, 'player1')
  assert.match(showdown.game.resultLabel, /Ace-high straight flush/)
  call(api.settlePokerGame, {gameId: 'known-winner'})
  assert.equal(payments.length, 1)
  assert.equal(payments[0].lnurl, 'one@example.com')
  assert.equal(payments[0].amount, 190)
}

{
  const {api, tables, payments} = createHarness()
  call(api.savePokerSettings, {enabled: true, walletId: 'wallet-1', haircut: 10})
  call(api.createPokerGame, {
    id: 'real-split',
    joinAmount: 100,
    matchTarget: 1
  })
  pay(api, 'real-split', 'tie-one', 'one@example.com')
  pay(api, 'real-split', 'tie-two', 'two@example.com')
  const secrets = tables.get('poker_secrets').get('real-split')
  tables.get('poker_secrets').set('real-split', {
    ...secrets,
    player1_hand_json: JSON.stringify(['AS', 'KD', 'QH', 'JC', '9S']),
    player2_hand_json: JSON.stringify(['AH', 'KC', 'QS', 'JD', '9H'])
  })
  call(api.drawPokerCards, {
    gameId: 'real-split',
    playerToken: 'tie-one',
    discardIndices: []
  })
  const split = call(api.drawPokerCards, {
    gameId: 'real-split',
    playerToken: 'tie-two',
    discardIndices: []
  })
  assert.equal(split.game.status, 'draw')
  assert.equal(split.game.winnerSeat, '')
  call(api.settlePokerGame, {gameId: 'real-split'})
  assert.deepEqual(
    payments.map(payment => [payment.lnurl, payment.amount]),
    [['one@example.com', 100], ['two@example.com', 100]]
  )
}

{
  const {api, tables, payments} = createHarness()
  call(api.savePokerSettings, {
    enabled: true,
    walletId: 'wallet-1',
    haircut: 5
  })
  const created = call(api.createPokerGame, {
    id: 'best-of-five',
    joinAmount: 100
  })
  assert.equal(created.game.matchTarget, 3)
  assert.equal(created.game.handNumber, 1)
  assert.equal(created.game.player1Score, 0)
  assert.equal(created.game.player2Score, 0)
  pay(api, 'best-of-five', 'match-one', 'one@example.com')
  pay(api, 'best-of-five', 'match-two', 'two@example.com')

  let hand = call(api.foldPokerGame, {
    gameId: 'best-of-five',
    playerToken: 'match-one'
  })
  assert.equal(hand.game.status, 'between-hands')
  assert.equal(hand.game.player2Score, 1)
  assert.equal(hand.game.winnerSeat, 'player2')
  assert.equal(hand.game.winnerLnAddress, 'two@example.com')
  assert.equal(hand.game.payoutPending, false)
  assert.equal(payments.length, 0)

  const interrupted = tables.get('poker_games').get('best-of-five')
  tables.get('poker_games').set('best-of-five', {
    ...interrupted,
    status: 'dealing',
    hand_number: 2
  })
  const second = call(api.startNextPokerHand, {
    gameId: 'best-of-five',
    playerToken: 'match-one'
  })
  assert.equal(second.started, true)
  assert.equal(second.game.handNumber, 2)
  assert.equal(second.game.turn, 'player2')
  assert.notEqual(second.game.deckCommitment, created.game.deckCommitment)
  assert(second.hand.every(card => card.code && !card.hidden))
  const duplicate = call(api.startNextPokerHand, {
    gameId: 'best-of-five',
    playerToken: 'match-two'
  })
  assert.equal(duplicate.started, false)
  assert.equal(duplicate.game.handNumber, 2)

  hand = call(api.foldPokerGame, {
    gameId: 'best-of-five',
    playerToken: 'match-two'
  })
  assert.equal(hand.game.player1Score, 1)
  assert.equal(hand.game.player2Score, 1)
  call(api.startNextPokerHand, {
    gameId: 'best-of-five',
    playerToken: 'match-two'
  })

  hand = call(api.foldPokerGame, {
    gameId: 'best-of-five',
    playerToken: 'match-one'
  })
  assert.equal(hand.game.player2Score, 2)
  call(api.startNextPokerHand, {
    gameId: 'best-of-five',
    playerToken: 'match-one'
  })

  hand = call(api.foldPokerGame, {
    gameId: 'best-of-five',
    playerToken: 'match-two'
  })
  assert.equal(hand.game.player1Score, 2)
  call(api.startNextPokerHand, {
    gameId: 'best-of-five',
    playerToken: 'match-two'
  })

  const match = call(api.foldPokerGame, {
    gameId: 'best-of-five',
    playerToken: 'match-one'
  })
  assert.equal(match.game.status, 'completed')
  assert.equal(match.game.handNumber, 5)
  assert.equal(match.game.player1Score, 2)
  assert.equal(match.game.player2Score, 3)
  assert.equal(match.game.winnerSeat, 'player2')
  assert.equal(match.game.payoutPending, true)
  assert.match(match.game.resultLabel, /wins the match 2–3/)
  assert.equal(payments.length, 0)

  const view = call(api.getPublicPokerGame, {
    gameId: 'best-of-five',
    playerToken: 'match-one'
  })
  assert.deepEqual(
    [...new Set(view.actions.map(action => action.handNumber))],
    [1, 2, 3, 4, 5]
  )
  assert.equal(view.actions.filter(action => action.type === 'deal').length, 4)

  const settlement = call(api.settlePlayerPokerPayout, {
    gameId: 'best-of-five',
    playerToken: 'match-two'
  })
  assert.equal(settlement.payout.ok, true)
  assert.equal(payments.length, 1)
  assert.equal(payments[0].lnurl, 'two@example.com')
  assert.equal(payments[0].amount, 190)
}

{
  const {api, tables, payments} = createHarness()
  call(api.savePokerSettings, {
    enabled: true,
    walletId: 'wallet-1',
    haircut: 0
  })
  call(api.createPokerGame, {
    id: 'match-tie',
    joinAmount: 100
  })
  pay(api, 'match-tie', 'tie-match-one', 'one@example.com')
  pay(api, 'match-tie', 'tie-match-two', 'two@example.com')
  const secrets = tables.get('poker_secrets').get('match-tie')
  tables.get('poker_secrets').set('match-tie', {
    ...secrets,
    player1_hand_json: JSON.stringify(['AS', 'KD', 'QH', 'JC', '9S']),
    player2_hand_json: JSON.stringify(['AH', 'KC', 'QS', 'JD', '9H'])
  })
  call(api.drawPokerCards, {
    gameId: 'match-tie',
    playerToken: 'tie-match-one',
    discardIndices: []
  })
  const tie = call(api.drawPokerCards, {
    gameId: 'match-tie',
    playerToken: 'tie-match-two',
    discardIndices: []
  })
  assert.equal(tie.game.status, 'between-hands')
  assert.equal(tie.game.player1Score, 0)
  assert.equal(tie.game.player2Score, 0)
  assert.equal(tie.game.winnerSeat, '')
  assert.equal(tie.game.winnerLnAddress, '')
  assert.equal(tie.game.payoutPending, false)
  assert.equal(tie.game.revealedSeed, 'deck-1:seed-2')
  assert.equal(payments.length, 0)
  const next = call(api.startNextPokerHand, {
    gameId: 'match-tie',
    playerToken: 'tie-match-two'
  })
  assert.equal(next.game.handNumber, 2)
  assert.equal(next.game.turn, 'player2')
}

{
  const {api, tables, wallet, payments} = createHarness()
  call(api.savePokerSettings, {enabled: true, walletId: 'wallet-1', haircut: 0})
  call(api.createPokerGame, {id: 'payment-edges', joinAmount: 100})

  const zero = pay(api, 'payment-edges', 'zero-token', 'zero@example.com', 0)
  assert.equal(zero.status, 'amount-mismatch')
  assert.equal(zero.game.playersCount, 0)
  assert.equal(payments.length, 0)

  const fractional = pay(
    api,
    'payment-edges',
    'fraction-token',
    'fraction@example.com',
    100001
  )
  assert.equal(fractional.status, 'refunded')
  assert.equal(fractional.game.playersCount, 0)
  assert.equal(payments.at(-1).amount, 100)
  assert.equal(
    call(api.getPublicPokerGame, {
      gameId: 'payment-edges',
      playerToken: 'fraction-token'
    }).paymentStatus,
    'refunded'
  )

  pay(api, 'payment-edges', 'edge-one', 'one@example.com')
  const game = tables.get('poker_games').get('payment-edges')
  tables.get('poker_games').set('payment-edges', {
    ...game,
    players_count: 0,
    player1_ln_address: '',
    player1_payment_hash: ''
  })
  const recovered = pay(api, 'payment-edges', 'edge-one', 'one@example.com')
  assert.equal(recovered.status, 'paid')
  assert.equal(recovered.game.playersCount, 1)
  assert.equal(recovered.player.seat, 'player1')

  pay(api, 'payment-edges', 'edge-two', 'two@example.com')
  wallet.outcomes.push({ok: false, error: 'temporary refund failure'})
  const late = pay(api, 'payment-edges', 'late-token', 'late@example.com')
  assert.equal(late.status, 'refund-pending')
  wallet.outcomes.push({ok: true, status: 'success', success: true})
  const retried = pay(api, 'payment-edges', 'late-token', 'late@example.com')
  assert.equal(retried.status, 'refunded')
  assert.equal(
    payments.filter(payment => payment.lnurl === 'late@example.com').length,
    2
  )
}

{
  const {api, tables} = createHarness()
  call(api.savePokerSettings, {enabled: true, walletId: 'wallet-1', haircut: 0})
  call(api.createPokerGame, {id: 'refunded-only', joinAmount: 100})
  pay(api, 'refunded-only', 'refunded-token', 'refund@example.com', 99000)
  assert(tables.get('poker_players').has('refunded-token'))
  call(api.deletePokerGame, {gameId: 'refunded-only'})
  assert(!tables.get('poker_players').has('refunded-token'))
}

{
  const {api, tables, wallet, payments} = createHarness()
  call(api.savePokerSettings, {enabled: true, walletId: 'wallet-1', haircut: 0})
  call(api.createPokerGame, {id: 'split', joinAmount: 100})
  pay(api, 'split', 'split-one', 'one@example.com')
  pay(api, 'split', 'split-two', 'two@example.com')
  const game = tables.get('poker_games').get('split')
  tables.get('poker_games').set('split', {
    ...game,
    status: 'draw',
    payout_pending: true,
    payout_status: 'pending',
    player1_payout_status: 'pending',
    player2_payout_status: 'pending'
  })
  wallet.outcomes.push(
    {ok: true, status: 'success', success: true},
    {ok: false, error: 'temporary failure'}
  )
  const first = call(api.settlePokerGame, {gameId: 'split'})
  assert.equal(first.payout.ok, false)
  assert.equal(payments.length, 2)
  assert.equal(tables.get('poker_games').get('split').player1_payout_status, 'paid')

  wallet.outcomes.push({ok: true, status: 'success', success: true})
  const retry = call(api.settlePokerGame, {gameId: 'split'})
  assert.equal(retry.payout.ok, true)
  assert.equal(payments.length, 3)
  assert.equal(payments.filter(item => item.lnurl === 'one@example.com').length, 1)
  assert.equal(payments.filter(item => item.lnurl === 'two@example.com').length, 2)
}

{
  const {api, tables, wallet, payments} = createHarness()
  call(api.savePokerSettings, {enabled: true, walletId: 'wallet-1', haircut: 0})
  call(api.createPokerGame, {
    id: 'atomic-payout',
    joinAmount: 100,
    matchTarget: 1
  })
  pay(api, 'atomic-payout', 'atomic-one', 'one@example.com')
  pay(api, 'atomic-payout', 'atomic-two', 'two@example.com')
  call(api.foldPokerGame, {
    gameId: 'atomic-payout',
    playerToken: 'atomic-one'
  })
  const staleGame = structuredClone(tables.get('poker_games').get('atomic-payout'))

  const first = api.settlePayouts(staleGame)
  const racing = api.settlePayouts(staleGame)

  assert.equal(first.payout.ok, true)
  assert.equal(racing.payout.ok, true)
  assert.equal(payments.length, 1)
}

{
  const {api, tables, wallet, payments} = createHarness()
  call(api.savePokerSettings, {enabled: true, walletId: 'wallet-1', haircut: 0})
  call(api.createPokerGame, {
    id: 'pending-payout',
    joinAmount: 100,
    matchTarget: 1
  })
  pay(api, 'pending-payout', 'pending-one', 'one@example.com')
  pay(api, 'pending-payout', 'pending-two', 'two@example.com')
  call(api.foldPokerGame, {
    gameId: 'pending-payout',
    playerToken: 'pending-one'
  })
  wallet.outcomes.push({
    ok: true,
    status: 'pending',
    success: false,
    pending: true,
    paymentHash: 'pending-payment'
  })

  const first = call(api.settlePokerGame, {gameId: 'pending-payout'})
  assert.equal(first.payout.ok, false)
  assert.equal(first.payout.pending, true)
  assert.equal(
    tables.get('poker_games').get('pending-payout').player2_payout_status,
    'pending'
  )
  assert.equal(payments.length, 1)

  const stillPending = call(api.settlePokerGame, {gameId: 'pending-payout'})
  assert.equal(stillPending.payout.pending, true)
  assert.equal(payments.length, 1)

  const unchanged = call(api.settlePokerGame, {gameId: 'pending-payout'})
  assert.equal(unchanged.payout.ok, false)
  assert.equal(unchanged.payout.pending, true)
  assert.equal(unchanged.game.payoutPending, true)
  assert.equal(payments.length, 1)
}

console.log('poker tests passed')
