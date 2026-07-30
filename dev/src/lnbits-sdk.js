import {createInvoicePublic, listUserWallets, log, now, payLnurl, randomId, storageDelete, storageGet, storageGetPaginated, storageSet, websocketPublish} from 'lnbits:extension/host'

export const storage = {
  get(table, id, fallback = null) {
    const response = storageGet({table, id})
    return response.dataJson ? JSON.parse(response.dataJson) : fallback
  },
  set(table, data) {
    storageSet({table, dataJson: JSON.stringify(data)})
    return data
  },
  getPaginated(table, options = {}) {
    const response = storageGetPaginated({
      table,
      filtersJson: JSON.stringify(options.filters || {}),
      search: options.search || '',
      searchFields: options.searchFields || [],
      sortBy: options.sortBy || '',
      descending: options.descending === true,
      limit: options.limit || 25,
      offset: options.offset || 0
    })
    return {data: JSON.parse(response.rowsJson || '[]'), total: Number(response.total || 0)}
  },
  delete(table, id) {
    return storageDelete({table, id})
  }
}

export const wallet = {
  listUserWallets() {
    return listUserWallets().wallets || []
  },
  createInvoicePublic({sourceId, amount, memo = '', extra = {}}) {
    return createInvoicePublic({
      sourceId,
      amount: Number(amount),
      currency: 'sat',
      memo,
      extra: Object.entries(extra).map(([key, value]) => [key, String(value)])
    })
  },
  payLnurl({walletId, lnurl, amount, comment, maxSat, description, extra = {}}) {
    return payLnurl({
      walletId,
      lnurl,
      amount: Number(amount),
      currency: 'sat',
      comment: comment || undefined,
      maxSat: BigInt(maxSat),
      description,
      extra: Object.entries(extra).map(([key, value]) => [key, String(value)])
    })
  }
}

export const system = {
  id(prefix) {
    return randomId({prefix}).id
  },
  now() {
    const response = now()
    return Number(response.timestamp || response.value || response)
  },
  log(message, level = 'info') {
    return log({level, message})
  }
}

export const websocket = {
  publish(itemId, data) {
    return websocketPublish({itemId, dataJson: JSON.stringify(data)}).sent
  }
}
