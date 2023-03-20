/** @decorator */

import ppp from '../../ppp.js';
import { html, css, ref } from '../../vendor/fast-element.min.js';
import { Page, pageStyles } from '../page.js';
import { BROKERS, EXCHANGE } from '../../lib/const.js';
import { maybeFetchError } from '../../lib/ppp-errors.js';
import '../button.js';
import '../select.js';

export const instrumentsImportPageTemplate = html`
  <template class="${(x) => x.generateClasses()}">
    <ppp-loader></ppp-loader>
    <form novalidate>
      <section>
        <div class="label-group">
          <h5>Словарь</h5>
          <p class="description">
            Выберите словарь-источник для импорта инструментов.
          </p>
        </div>
        <div class="input-group">
          <ppp-select value="BINANCE" ${ref('dictionary')}>
            <ppp-option value="BINANCE">Binance</ppp-option>
          </ppp-select>
        </div>
      </section>
      <footer>
        <ppp-button
          type="submit"
          appearance="primary"
          @click="${(x) => x.submitDocument()}"
          ${ref('submitControl')}
        >
          Импортировать инструменты
        </ppp-button>
      </footer>
    </form>
  </template>
`;

export const instrumentsImportPageStyles = css`
  ${pageStyles}
`;

export class InstrumentsImportPage extends Page {
  collection = 'instruments';

  async importFromBinance() {
    const rExchangeInfo = await fetch(
      `https://api.binance.com/api/v3/exchangeInfo`,
      {
        cache: 'reload'
      }
    );

    await maybeFetchError(
      rExchangeInfo,
      'Не удалось загрузить список инструментов.'
    );

    const { symbols } = await rExchangeInfo.json();
    const result = [];

    for (const s of symbols) {
      result.push({
        symbol: s.symbol,
        exchange: EXCHANGE.BINANCE,
        broker: BROKERS.BINANCE,
        fullName: `${s.baseAsset}/${s.quoteAsset}`,
        minPriceIncrement: parseFloat(
          s.filters.find((f) => f.filterType === 'PRICE_FILTER').tickSize
        ),
        minQuantityIncrement: parseFloat(
          s.filters.find((f) => f.filterType === 'LOT_SIZE').stepSize
        ),
        type: 'cryptocurrency',
        baseCryptoAsset: s.baseAsset,
        quoteCryptoAsset: s.quoteAsset,
        minNotional: parseFloat(
          s.filters.find((f) => f.filterType === 'MIN_NOTIONAL').minNotional
        ),
        forQualInvestorFlag: false
      });
    }

    return result;
  }

  async submitDocument() {
    this.beginOperation();

    try {
      let instruments = [];

      switch (this.dictionary.value) {
        case 'BINANCE':
          instruments = await this.importFromBinance();
      }

      await ppp.user.functions.bulkWrite(
        {
          collection: 'instruments'
        },
        instruments.map((i) => {
          const updateClause = {
            $set: i
          };

          return {
            updateOne: {
              filter: {
                symbol: i.symbol,
                exchange: i.exchange,
                broker: i.broker
              },
              update: updateClause,
              upsert: true
            }
          };
        }),
        {
          ordered: false
        }
      );

      let exchange;
      let broker;

      switch (this.dictionary.value) {
        case 'BINANCE':
          exchange = EXCHANGE.BINANCE;
          broker = BROKERS.BINANCE;

          break;
      }

      if (exchange && broker) {
        // Use this to preserve user field values
        const existingInstruments = await ppp.user.functions.find(
          {
            collection: 'instruments'
          },
          {
            exchange,
            broker
          }
        );

        const nextCacheVersion = await ppp.nextInstrumentCacheVersion({
          exchange,
          broker
        });
        const cache = await ppp.openInstrumentCache({
          exchange,
          broker
        });

        try {
          await new Promise((resolve, reject) => {
            const storeName = `${exchange}:${broker}`;
            const tx = cache.transaction(storeName, 'readwrite');
            const instrumentsStore = tx.objectStore(storeName);

            instrumentsStore.put({
              symbol: '@version',
              version: nextCacheVersion
            });

            instruments.forEach((i) => {
              const existingInstrument = existingInstruments.find(
                (ei) => ei.symbol === i.symbol
              );

              if (existingInstrument?.removed) {
                // User flags
                i.removed = true;
              }

              instrumentsStore.put(i);
            });

            tx.oncomplete = () => {
              resolve();
            };

            tx.onerror = (event) => {
              reject(event.target.error);
            };
          });
        } finally {
          cache.close();
        }
      }

      this.showSuccessNotification();
    } catch (e) {
      this.failOperation(e);
    } finally {
      this.endOperation();
    }
  }
}

export default InstrumentsImportPage.compose({
  template: instrumentsImportPageTemplate,
  styles: instrumentsImportPageStyles
}).define();
