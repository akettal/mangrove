import * as ethers from "ethers";
import { BigNumber } from "ethers"; // syntactic sugar
import {
  TradeParams,
  BookOptions,
  BookReturns,
  Bigish,
  rawConfig,
  localConfig,
  bookSubscriptionEvent,
} from "./types";
import { Mangrove } from "./mangrove";
import { MgvToken } from "./mgvtoken";

// FIXME probably need classes/interfaces here
type BQToken<BQ extends "base" | "quote"> = {
  fromUnits: (units: BigNumber) => BQAmount<BQ>;
};

type BaseToken = {
  bq: "base";
  token: MgvToken;
  fromUnits: (units: BigNumber) => BaseAmount;
};
type QuoteToken = {
  bq: "quote";
  token: MgvToken;
  fromUnits: (units: BigNumber) => QuoteAmount;
};

type GivesToken<BA extends "asks" | "bids"> = BA extends "asks"
  ? BaseToken
  : QuoteToken;
type WantsToken<BA extends "asks" | "bids"> = BA extends "asks"
  ? QuoteToken
  : BaseToken;

type BaseAmount = { bq: "base"; amount: Big };
type QuoteAmount = { bq: "quote"; amount: Big };
type BQAmount<BQ extends "base" | "quote"> = BQ extends "base"
  ? BaseAmount
  : QuoteAmount;

type GivesAmount<BA extends "asks" | "bids"> = BA extends "asks"
  ? BaseAmount
  : QuoteAmount;
type WantsAmount<BA extends "asks" | "bids"> = BA extends "asks"
  ? QuoteAmount
  : BaseAmount;

export type Offer<BA extends "asks" | "bids"> = {
  id: number;
  prev: number;
  next: number;
  gasprice: number;
  maker: string;
  gasreq: number;
  overhead_gasbase: number;
  offer_gasbase: number;
  wants: WantsAmount<BA>;
  gives: GivesAmount<BA>;
  volume: Big;
  price: Big;
};

let canConstructMarket = false;

const DEFAULT_MAX_OFFERS = 50;
const MAX_MARKET_ORDER_GAS = 6500000;

/* Note on big.js:
ethers.js's BigNumber (actually BN.js) only handles integers
big.js handles arbitrary precision decimals, which is what we want
for more on big.js vs decimals.js vs. bignumber.js (which is *not* ethers's BigNumber):
  github.com/MikeMcl/big.js/issues/45#issuecomment-104211175
*/
import Big from "big.js";
import { tokenToString } from "typescript";
Big.DP = 20; // precision when dividing
Big.RM = Big.roundHalfUp; // round to nearest

type OrderResult = { got: Big; gave: Big };
const bookOptsDefault: BookOptions = {
  fromId: 0,
  maxOffers: DEFAULT_MAX_OFFERS,
};

type offerList<BA extends "asks" | "bids"> = {
  offers: Map<number, Offer<BA>>;
  best: number;
};

type semibook<BA extends "asks" | "bids"> = offerList<BA> & {
  ba: BA;
  gasbase: { offer_gasbase: number; overhead_gasbase: number };
};

type OfferData = {
  id: number | BigNumber;
  prev: number | BigNumber;
  next: number | BigNumber;
  gasprice: number | BigNumber;
  maker: string;
  gasreq: number | BigNumber;
  overhead_gasbase: number | BigNumber;
  offer_gasbase: number | BigNumber;
  wants: BigNumber;
  gives: BigNumber;
};

export type bookSubscriptionCbArgument<BA extends "asks" | "bids"> = {
  ba: BA;
  offer: Offer<BA>;
} & (
  | { type: "OfferWrite" }
  | {
      type: "OfferFail";
      taker: string;
      takerWants: Big;
      takerGives: Big;
      mgvData: string;
    }
  | { type: "OfferSuccess"; taker: string; takerWants: Big; takerGives: Big }
  | { type: "OfferRetract" }
);

type marketCallback<T> = (
  cbArg: bookSubscriptionCbArgument<"asks" | "bids">,
  event?: bookSubscriptionEvent,
  ethersEvent?: ethers.Event
) => T;
type storableMarketCallback = marketCallback<any>;
type marketFilter = marketCallback<boolean>;
type subscriptionParam =
  | { type: "multiple" }
  | {
      type: "once";
      ok: (...a: any[]) => any;
      ko: (...a: any[]) => any;
      filter?: (...a: any[]) => boolean;
    };

/**
 * The Market class focuses on a mangrove market.
 * Onchain, market are implemented as two orderbooks,
 * one for the pair (base,quote), the other for the pair (quote,base).
 *
 * Market initialization needs to store the network name, so you cannot
 * directly use the constructor. Instead of `new Market(...)`, do
 *
 * `await Market.connect(...)`
 */
export class Market {
  mgv: Mangrove;
  base: BaseToken;
  quote: QuoteToken;
  #subscriptions: Map<storableMarketCallback, subscriptionParam>;
  #lowLevelCallbacks: null | { asksCallback?: any; bidsCallback?: any };
  _book: { asks: Offer<"asks">[]; bids: Offer<"bids">[] };

  static async connect(params: {
    mgv: Mangrove;
    base: string;
    quote: string;
    bookOptions?: BookOptions;
  }): Promise<Market> {
    canConstructMarket = true;
    const market = new Market(params);
    canConstructMarket = false;
    await market.#initialize(params.bookOptions);
    return market;
  }

  /**
   * Initialize a new `params.base`:`params.quote` market.
   *
   * `params.mgv` will be used as mangrove instance
   */
  constructor(params: { mgv: Mangrove; base: string; quote: string }) {
    if (!canConstructMarket) {
      throw Error(
        "Mangrove Market must be initialized async with Market.connect (constructors cannot be async)"
      );
    }
    this.#subscriptions = new Map();
    this.#lowLevelCallbacks = null;
    this.mgv = params.mgv;

    const baseToken = this.mgv.token(params.base);
    const quoteToken = this.mgv.token(params.quote);
    this.base = {
      bq: "base",
      token: baseToken,
      fromUnits: (amount) => {
        return { bq: "base", amount: baseToken.fromUnits(amount) };
      },
    };
    this.quote = {
      bq: "quote",
      token: quoteToken,
      fromUnits: (amount) => {
        return { bq: "quote", amount: quoteToken.fromUnits(amount) };
      },
    };
    // this.base = {
    //   name: params.base,
    //   address: this.mgv.getAddress(params.base),
    // };

    // this.quote = {
    //   name: params.quote,
    //   address: this.mgv.getAddress(params.quote),
    // };
    this._book = { asks: [], bids: [] };
  }

  /* Given a price, find the id of the immediately-better offer in the
     book. */
  getPivot(ba: "asks" | "bids", price: Bigish): number {
    // we select as pivot the immediately-better offer
    // the actual ordering in the offer list is lexicographic
    // price * gasreq (or price^{-1} * gasreq)
    // we ignore the gasreq comparison because we may not
    // know the gasreq (could be picked by offer contract)
    price = Big(price);
    const comparison = ba === "asks" ? "gt" : "lt";
    let latest_id = 0;
    for (const offer of this._book[ba]) {
      if (offer.price[comparison](price)) {
        break;
      }
      latest_id = offer.id;
    }
    return latest_id;
  }

  async isActive(): Promise<boolean> {
    const config = await this.config();
    return config.asks.active && config.bids.active;
  }

  /** Determine which token will be Mangrove's outbound/inbound depending on whether you're working with bids or asks. */
  getOutboundInbound(ba: "asks" | "bids"): {
    outbound_tkn: GivesToken<typeof ba>;
    inbound_tkn: WantsToken<typeof ba>;
  } {
    return {
      outbound_tkn: ba === "asks" ? this.base : this.quote,
      inbound_tkn: ba === "asks" ? this.quote : this.base,
    };
  }

  /** Determine whether gives or wants will be baseVolume/quoteVolume depending on whether you're working with bids or asks. */
  getBaseQuoteVolumes(
    ba: "asks" | "bids",
    gives: GivesAmount<typeof ba>,
    wants: WantsAmount<typeof ba>
  ): { baseVolume: BaseAmount; quoteVolume: QuoteAmount } {
    return {
      baseVolume: ba === "asks" ? gives : wants,
      quoteVolume: ba === "asks" ? wants : gives,
    };
  }

  /** Determine the price from gives or wants depending on whether you're working with bids or asks. */
  getPrice(ba: "asks" | "bids", gives: Big, wants: Big): Big {
    const { baseVolume, quoteVolume } = this.getBaseQuoteVolumes(
      ba,
      gives,
      wants
    );
    return quoteVolume.div(baseVolume);
  }

  /** Determine the wants from gives and price depending on whether you're working with bids or asks. */
  getWantsForPrice(ba: "asks" | "bids", gives: Big, price: Big): Big {
    return ba === "asks" ? gives.mul(price) : gives.div(price);
  }

  /** Determine the gives from wants and price depending on whether you're working with bids or asks. */
  getGivesForPrice(ba: "asks" | "bids", wants: Big, price: Big): Big {
    return ba === "asks" ? wants.div(price) : wants.mul(price);
  }

  /* Stop calling a user-provided function on book-related events. */
  unsubscribe(cb: storableMarketCallback): void {
    this.#subscriptions.delete(cb);
  }

  /* Stop listening to events from mangrove */
  disconnect(): void {
    const { asksFilter, bidsFilter } = this.#bookFilter();
    if (!this.#lowLevelCallbacks) return;
    const { asksCallback, bidsCallback } = this.#lowLevelCallbacks;
    this.mgv.contract.off(asksFilter, asksCallback);
    this.mgv.contract.off(bidsFilter, bidsCallback);
  }

  /* eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types */
  #bookFilter() {
    /* Disjunction of possible event names */
    const topics0 = [
      "OfferSuccess",
      "OfferFail",
      "OfferWrite",
      "OfferRetract",
      "SetGasbase",
    ].map((e) =>
      this.mgv.contract.interface.getEventTopic(
        this.mgv.contract.interface.getEvent(e as any)
      )
    );

    const base_padded = ethers.utils.hexZeroPad(this.base.token.address, 32);
    const quote_padded = ethers.utils.hexZeroPad(this.quote.token.address, 32);

    const asksFilter = {
      address: this.mgv._address,
      topics: [topics0, base_padded, quote_padded],
    };

    const bidsFilter = {
      address: this.mgv._address,
      topics: [topics0, quote_padded, base_padded],
    };

    return { asksFilter, bidsFilter };
  }

  /**
   *
   * Subscribe to orderbook updates.
   *
   * `cb` gets called whenever the orderbook is updated.
   *  Its first argument `event` is a summary of the event. It has the following properties:
   *
   * * `type` the type of change. May be: * `"OfferWrite"`: an offer was
   * inserted  or moved in the book.  * `"OfferFail"`, `"OfferSuccess"`,
   * `"OfferRetract"`: an offer was removed from the book because it failed,
   * succeeded, or was canceled.
   *
   * * `ba` is either `"bids"` or `"asks"`. The offer concerned by the change is
   * either an ask (an offer for `base` asking for `quote`) or a bid (`an offer
   * for `quote` asking for `base`).
   *
   * * `offer` is information about the offer, see type `Offer`.
   *
   * * `taker`, `takerWants`, `takerGives` (for `"OfferFail"` and
   * `"OfferSuccess"` only): address of the taker who executed the offer as well
   * as the volumes that were requested by the taker.
   *
   * * `mgvData` : extra data from mangrove and the maker
   * contract. See the [Mangrove contracts documentation](#TODO) for the list of possible status codes.
   *
   * `opts` may specify the maximum of offers to read initially, and the chunk
   * size used when querying the reader contract (always ran locally).
   *
   * @example
   * ```
   * const market = await mgv.market({base:"USDC",quote:"DAI"}
   * await market.subscribe((event,utils) => console.log(event.type, utils.book()))
   * ```
   *
   * @note The subscription is only effective once the void Promise returned by `subscribe` has fulfilled.
   *
   * @note Only one subscription may be active at a time.
   */
  async subscribe(cb: marketCallback<void>): Promise<void> {
    this.#subscriptions.set(cb, { type: "multiple" });
  }

  /**
   *  Returns a promise which is fulfilled after execution of the callback.
   */
  async once<T>(cb: marketCallback<T>, filter?: marketFilter): Promise<T> {
    return new Promise((ok, ko) => {
      const params: subscriptionParam = { type: "once", ok, ko };
      if (typeof filter !== "undefined") {
        params.filter = filter;
      }
      this.#subscriptions.set(cb as storableMarketCallback, params);
    });
  }

  async #initialize(
    opts: Omit<BookOptions, "fromId"> = bookOptsDefault
  ): Promise<void> {
    if (this.#lowLevelCallbacks) throw Error("Already initialized.");

    let asksInilizationCompleteCallback: ({
      semibook: semibook,
      firstBlockNumber: number,
    }) => void;
    const asksInitializationPromise = new Promise<{
      semibook: semibook<"asks">;
      firstBlockNumber: number;
    }>((ok) => {
      asksInilizationCompleteCallback = ok;
    });
    let bidsInilizationCompleteCallback: ({
      semibook: semibook,
      firstBlockNumber: number,
    }) => void;
    const bidsInitializationPromise = new Promise<{
      semibook: semibook<"bids">;
      firstBlockNumber: number;
    }>((ok) => {
      bidsInilizationCompleteCallback = ok;
    });

    const asksCallback = this.#createBookEventCallback(
      asksInitializationPromise
    );
    const bidsCallback = this.#createBookEventCallback(
      bidsInitializationPromise
    );

    this.#lowLevelCallbacks = { asksCallback, bidsCallback };

    const { asksFilter, bidsFilter } = this.#bookFilter();
    this.mgv.contract.on(asksFilter, asksCallback);
    this.mgv.contract.on(bidsFilter, bidsCallback);

    const config = await this.config();

    await this.#initializeSemibook(
      "asks",
      config.asks,
      asksInilizationCompleteCallback,
      opts
    );
    await this.#initializeSemibook(
      "bids",
      config.bids,
      bidsInilizationCompleteCallback,
      opts
    );
  }

  #mapConfig(ba: "bids" | "asks", cfg: rawConfig): localConfig {
    const { outbound_tkn } = this.getOutboundInbound(ba);
    return {
      active: cfg.local.active,
      fee: cfg.local.fee.toNumber(),
      density: outbound_tkn.token.fromUnits(cfg.local.density),
      overhead_gasbase: cfg.local.overhead_gasbase.toNumber(),
      offer_gasbase: cfg.local.offer_gasbase.toNumber(),
      lock: cfg.local.lock,
      best: cfg.local.best.toNumber(),
      last: cfg.local.last.toNumber(),
    };
  }

  /**
   * Return config local to a market.
   * Returned object is of the form
   * {bids,asks} where bids and asks are of type `localConfig`
   * Notes:
   * Amounts are converted to plain numbers.
   * density is converted to public token units per gas used
   * fee *remains* in basis points of the token being bought
   */
  async rawConfig(): Promise<{ asks: rawConfig; bids: rawConfig }> {
    const rawAskConfig = await this.mgv.readerContract.config(
      this.base.token.address,
      this.quote.token.address
    );
    const rawBidsConfig = await this.mgv.readerContract.config(
      this.quote.token.address,
      this.base.token.address
    );
    return {
      asks: rawAskConfig,
      bids: rawBidsConfig,
    };
  }

  async config(): Promise<{ asks: localConfig; bids: localConfig }> {
    const { bids, asks } = await this.rawConfig();
    return {
      asks: this.#mapConfig("asks", asks),
      bids: this.#mapConfig("bids", bids),
    };
  }

  /**
   * Market buy order. Will attempt to buy base token using quote tokens.
   * Params can be of the form:
   * - `{volume,price}`: buy `wants` tokens for a max average price of `price`, or
   * - `{wants,gives}`: accept implicit max average price of `gives/wants`
   *
   * Will stop if
   * - book is empty, or
   * - price no longer good, or
   * - `wants` tokens have been bought.
   *
   * @example
   * ```
   * const market = await mgv.market({base:"USDC",quote:"DAI"}
   * market.buy({volume: 100, price: '1.01'}) //use strings to be exact
   * ```
   */
  buy(params: TradeParams): Promise<OrderResult> {
    const _wants = "price" in params ? Big(params.volume) : Big(params.wants);
    const _gives =
      "price" in params ? _wants.mul(params.price) : Big(params.gives);

    const wants = this.base.token.toUnits(_wants);
    const gives = this.quote.token.toUnits(_gives);

    return this.#marketOrder({ gives, wants, orderType: "buy" });
  }

  /**
   * Market sell order. Will attempt to sell base token for quote tokens.
   * Params can be of the form:
   * - `{volume,price}`: sell `gives` tokens for a min average of `price`
   * - `{wants,gives}`: accept implicit min average price of `gives/wants`.
   *
   * Will stop if
   * - book is empty, or
   * - price no longer good, or
   * -`gives` tokens have been sold.
   *
   * @example
   * ```
   * const market = await mgv.market({base:"USDC",quote:"DAI"}
   * market.sell({volume: 100, price: 1})
   * ```
   */
  sell(params: TradeParams): Promise<OrderResult> {
    const _gives = "price" in params ? Big(params.volume) : Big(params.gives);
    const _wants =
      "price" in params ? _gives.mul(params.price) : Big(params.wants);

    const gives = this.base.token.toUnits(_gives);
    const wants = this.quote.token.toUnits(_wants);

    return this.#marketOrder({ wants, gives, orderType: "sell" });
  }

  /**
   * Low level Mangrove market order.
   * If `orderType` is `"buy"`, the base/quote market will be used,
   * with contract function argument `fillWants` set to true.
   *
   * If `orderType` is `"sell"`, the quote/base market will be used,
   * with contract function argument `fillWants` set to false.
   *
   * Returns a promise for market order result after 1 confirmation.
   * Will throw on same conditions as ethers.js `transaction.wait`.
   */
  async #marketOrder({
    wants,
    gives,
    orderType,
  }: {
    wants: ethers.BigNumber;
    gives: ethers.BigNumber;
    orderType: "buy" | "sell";
  }): Promise<{ got: Big; gave: Big }> {
    const [outboundTkn, inboundTkn, fillWants] =
      orderType === "buy"
        ? [this.base, this.quote, true]
        : [this.quote, this.base, false];

    const gasLimit = await this.estimateGas(orderType, wants);
    const response = await this.mgv.contract.marketOrder(
      outboundTkn.token.address,
      inboundTkn.token.address,
      wants,
      gives,
      fillWants,
      { gasLimit }
    );
    const receipt = await response.wait();

    let result: ethers.Event | undefined;
    //last OrderComplete is ours!
    for (const evt of receipt.events) {
      if (evt.event === "OrderComplete") {
        result = evt;
      }
    }
    if (!result) {
      throw Error("market order went wrong");
    }
    const got_bq = orderType === "buy" ? "base" : "quote";
    const gave_bq = orderType === "buy" ? "quote" : "base";
    return {
      got: this[got_bq].token.fromUnits(result.args.takerGot),
      gave: this[gave_bq].token.fromUnits(result.args.takerGave),
    };
  }

  /* Provides the book with raw BigNumber values */
  async rawBook(
    ba: "asks" | "bids",
    opts: BookOptions = bookOptsDefault
  ): Promise<[BookReturns.indices, BookReturns.offers, BookReturns.details]> {
    opts = { ...bookOptsDefault, ...opts };
    const { outbound_tkn, inbound_tkn } = this.getOutboundInbound(ba);
    // by default chunk size is number of offers desired
    const chunkSize =
      typeof opts.chunkSize === "undefined" ? opts.maxOffers : opts.chunkSize;
    // save total number of offers we want
    let maxOffersLeft = opts.maxOffers;

    let nextId = opts.fromId; // fromId == 0 means "start from best"
    let offerIds = [],
      offers = [],
      details = [];

    const blockNum =
      opts.blockNumber !== undefined
        ? opts.blockNumber
        : await this.mgv._provider.getBlockNumber(); //stay consistent by reading from one block
    await this.mgv.readerContract.config(this.mgv._address, this.mgv._address);
    do {
      const [_nextId, _offerIds, _offers, _details] =
        await this.mgv.readerContract.offerList(
          outbound_tkn.token.address,
          inbound_tkn.token.address,
          opts.fromId,
          chunkSize,
          { blockTag: blockNum }
        );
      offerIds = offerIds.concat(_offerIds);
      offers = offers.concat(_offers);
      details = details.concat(_details);
      nextId = _nextId.toNumber();
      maxOffersLeft = maxOffersLeft - chunkSize;
    } while (maxOffersLeft > 0 && nextId !== 0);

    return [offerIds, offers, details];
  }

  /**
   * Return current book state of the form
   * @example
   * ```
   * {
   *   asks: [
   *     {id: 3, price: 3700, volume: 4, ...},
   *     {id: 56, price: 3701, volume: 7.12, ...}
   *   ],
   *   bids: [
   *     {id: 811, price: 3600, volume: 1.23, ...},
   *     {id: 80, price: 3550, volume: 1.11, ...}
   *   ]
   * }
   * ```
   *  Asks are standing offers to sell base and buy quote.
   *  Bids are standing offers to buy base and sell quote.
   *  All prices are in quote/base, all volumes are in base.
   *  Order is from best to worse from taker perspective.
   */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  book() {
    return this._book;
  }

  async requestBook(
    opts: BookOptions = bookOptsDefault
  ): Promise<Market["_book"]> {
    const rawAsks = await this.rawBook("asks", opts);
    const rawBids = await this.rawBook("bids", opts);
    return {
      asks: this.rawToArray("asks", ...rawAsks),
      bids: this.rawToArray("bids", ...rawBids),
    };
  }

  rawToMap<BA extends "asks" | "bids">(
    ba: BA,
    ids: BookReturns.indices,
    offers: BookReturns.offers,
    details: BookReturns.details
  ): offerList<BA> {
    const data: offerList<BA> = {
      offers: new Map(),
      best: 0,
    };

    for (const [index, offerId] of ids.entries()) {
      if (index === 0) {
        data.best = ids[0].toNumber();
      }

      data.offers.set(
        offerId.toNumber(),
        this.#toOfferObject(ba, {
          id: ids[index],
          ...offers[index],
          ...details[index],
        })
      );
    }

    return data;
  }

  /**
   * Extend an array of offers returned by the mangrove contract with price/volume info.
   *
   * volume will always be in base token:
   * * if mapping asks, volume is token being bought by taker
   * * if mapping bids, volume is token being sold by taker
   */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  rawToArray(
    ba: "bids" | "asks",
    ids: BookReturns.indices,
    offers: BookReturns.offers,
    details: BookReturns.details
  ) {
    return ids.map((offerId, index) => {
      return this.#toOfferObject(ba, {
        id: ids[index],
        ...offers[index],
        ...details[index],
      });
    });
  }

  #toOfferObject<BA extends "asks" | "bids">(
    ba: BA,
    raw: OfferData
  ): Offer<BA> {
    const { outbound_tkn, inbound_tkn } = this.getOutboundInbound(ba);

    const _gives = outbound_tkn.fromUnits(raw.gives);
    const _wants = inbound_tkn.fromUnits(raw.wants);

    const { baseVolume } = this.getBaseQuoteVolumes(ba, _gives, _wants);
    const price = this.getPrice(ba, _gives, _wants);

    if (baseVolume.eq(0)) {
      throw Error("baseVolume is 0 (not allowed)");
    }

    const toNum = (i: number | BigNumber): number =>
      typeof i === "number" ? i : i.toNumber();

    return {
      id: toNum(raw.id),
      prev: toNum(raw.prev),
      next: toNum(raw.next),
      gasprice: toNum(raw.gasprice),
      maker: raw.maker,
      gasreq: toNum(raw.gasreq),
      overhead_gasbase: toNum(raw.overhead_gasbase),
      offer_gasbase: toNum(raw.offer_gasbase),
      gives: _gives,
      wants: _wants,
      volume: baseVolume,
      price: price,
    };
  }

  defaultCallback(
    cbArg: bookSubscriptionCbArgument,
    semibook: semibook,
    event: bookSubscriptionEvent,
    ethersEvent: ethers.Event
  ): void {
    this.#updateBook(semibook);
    for (const [cb, params] of this.#subscriptions) {
      if (params.type === "once") {
        if (!("filter" in params) || params.filter(cbArg, event, ethersEvent)) {
          this.#subscriptions.delete(cb);
          Promise.resolve(cb(cbArg, event, ethersEvent)).then(
            params.ok,
            params.ko
          );
        }
      } else {
        cb(cbArg, event, ethersEvent);
      }
    }
  }

  #updateBook(semibook: semibook): void {
    this._book[semibook.ba] = mapToArray(semibook.best, semibook.offers);
  }

  async #initializeSemibook(
    ba: "bids" | "asks",
    localConfig: localConfig,
    initializationCompleteCallback: ({
      semibook: semibook,
      firstBlockNumber: number,
    }) => void,
    opts: Omit<BookOptions, "fromId">
  ): Promise<void> {
    const firstBlockNumber: number = await this.mgv._provider.getBlockNumber();
    const rawOffers = await this.rawBook(ba, {
      ...opts,
      ...{ fromId: 0, blockNumber: firstBlockNumber },
    });

    const semibook = {
      ba: ba,
      gasbase: {
        overhead_gasbase: localConfig.overhead_gasbase,
        offer_gasbase: localConfig.offer_gasbase,
      },
      ...this.rawToMap(ba, ...rawOffers),
    };

    this.#updateBook(semibook);

    initializationCompleteCallback({ semibook, firstBlockNumber });
  }

  #createBookEventCallback(
    initializationPromise: Promise<{
      semibook: semibook;
      firstBlockNumber: number;
    }>
  ): (...args: any[]) => Promise<any> {
    return async (event) => {
      // Callbacks must ensure initialization has completed
      const { semibook, firstBlockNumber } = await initializationPromise;
      // If event is from firstBlockNumber (or before), ignore it as it will be included in the initially read offer list
      if (event.blockNumber <= firstBlockNumber) {
        return;
      }
      this.#handleBookEvent(semibook, event);
    };
  }

  #handleBookEvent(semibook: semibook, ethersEvent: ethers.Event): void {
    const event: bookSubscriptionEvent = this.mgv.contract.interface.parseLog(
      ethersEvent
    ) as any;

    let offer;
    let removedOffer;
    let next;

    const { outbound_tkn, inbound_tkn } = this.getOutboundInbound(semibook.ba);

    switch (event.name) {
      case "OfferWrite":
        // We ignore the return value here because the offer may have been outside the local
        // cache, but may now enter the local cache due to its new price.
        removeOffer(semibook, event.args.id.toNumber());

        /* After removing the offer (a noop if the offer was not in local cache),
            we reinsert it.

            * The offer comes with id of its prev. If prev does not exist in cache, we skip
            the event. Note that we still want to remove the offer from the cache.
            * If the prev exists, we take the prev's next as the offer's next. Whether that next exists in the cache or not is irrelevant.
        */
        try {
          next = getNext(semibook, event.args.prev.toNumber());
        } catch (e) {
          // offer.prev was not found, we are outside local OB copy. skip.
          break;
        }

        offer = this.#toOfferObject(semibook.ba, {
          ...event.args,
          ...semibook.gasbase,
          next: BigNumber.from(next),
        });

        insertOffer(semibook, event.args.id.toNumber(), offer);

        this.defaultCallback(
          {
            type: event.name,
            offer: offer,
            ba: semibook.ba,
          },
          semibook,
          event,
          ethersEvent
        );
        break;

      case "OfferFail":
        removedOffer = removeOffer(semibook, event.args.id.toNumber());
        // Don't trigger an event about an offer outside of the local cache
        if (removedOffer) {
          this.defaultCallback(
            {
              type: event.name,
              ba: semibook.ba,
              taker: event.args.taker,
              offer: removedOffer,
              takerWants: outbound_tkn.token.fromUnits(event.args.takerWants),
              takerGives: inbound_tkn.token.fromUnits(event.args.takerGives),
              mgvData: event.args.mgvData,
            },
            semibook,
            event,
            ethersEvent
          );
        }
        break;

      case "OfferSuccess":
        removedOffer = removeOffer(semibook, event.args.id.toNumber());
        if (removedOffer) {
          this.defaultCallback(
            {
              type: event.name,
              ba: semibook.ba,
              taker: event.args.taker,
              offer: removedOffer,
              takerWants: outbound_tkn.token.fromUnits(event.args.takerWants),
              takerGives: inbound_tkn.token.fromUnits(event.args.takerGives),
            },
            semibook,
            event,
            ethersEvent
          );
        }
        break;

      case "OfferRetract":
        removedOffer = removeOffer(semibook, event.args.id.toNumber());
        // Don't trigger an event about an offer outside of the local cache
        if (removedOffer) {
          this.defaultCallback(
            {
              type: event.name,
              ba: semibook.ba,
              offer: removedOffer,
            },
            semibook,
            event,
            ethersEvent
          );
        }
        break;

      case "SetGasbase":
        semibook.gasbase.overhead_gasbase =
          event.args.overhead_gasbase.toNumber();
        semibook.gasbase.offer_gasbase = event.args.offer_gasbase.toNumber();
        break;
      default:
        throw Error(`Unknown event ${event}`);
    }
  }

  async estimateGas(bs: "buy" | "sell", volume: BigNumber): Promise<BigNumber> {
    const rawConfig = await this.rawConfig();
    const ba = bs === "buy" ? "asks" : "bids";
    const estimation = rawConfig[ba].local.overhead_gasbase.add(
      volume.div(rawConfig[ba].local.density)
    );
    if (estimation.gt(MAX_MARKET_ORDER_GAS)) {
      return BigNumber.from(MAX_MARKET_ORDER_GAS);
    } else {
      return estimation;
    }
  }

  /**
   * Volume estimator, very crude (based on cached book).
   *
   * if you say `estimateVolume({given:100,what:"base",to:"buy"})`,
   *
   * it will give you an estimate of how much quote token you would have to
   * spend to get 100 base tokens.
   *
   * if you say `estimateVolume({given:10,what:"quote",to:"sell"})`,
   *
   * it will given you an estimate of how much base tokens you'd have to buy in
   * order to spend 10 quote tokens.
   * */
  estimateVolume(params: {
    given: Bigish;
    what: "base" | "quote";
    to: "buy" | "sell";
  }): { estimatedVolume: Big; givenResidue: Big } {
    const dict = {
      base: {
        buy: { offers: "asks", drainer: "gives", filler: "wants" },
        sell: { offers: "bids", drainer: "wants", filler: "gives" },
      },
      quote: {
        buy: { offers: "bids", drainer: "gives", filler: "wants" },
        sell: { offers: "asks", drainer: "wants", filler: "gives" },
      },
    } as const;

    const data = dict[params.what][params.to];

    const offers = this.book()[data.offers];
    let draining = Big(params.given);
    let filling = Big(0);
    for (const o of offers) {
      const _drainer = o[data.drainer];
      const drainer = draining.gt(_drainer) ? _drainer : draining;
      const filler = o[data.filler].times(drainer).div(_drainer);
      draining = draining.minus(drainer);
      filling = filling.plus(filler);
      if (draining.eq(0)) break;
    }
    return { estimatedVolume: filling, givenResidue: draining };
  }
}

// remove offer id from book and connect its prev/next.
// return null if offer was not found in book
const removeOffer = (semibook: semibook, id: number) => {
  const ofr = semibook.offers.get(id);
  if (ofr) {
    // we differentiate prev==0 (offer is best)
    // from offers[prev] does not exist (we're outside of the local cache)
    if (ofr.prev === 0) {
      semibook.best = ofr.next;
    } else {
      const prevOffer = semibook.offers.get(ofr.prev);
      if (prevOffer) {
        prevOffer.next = ofr.next;
      }
    }

    // checking that nextOffers exists takes care of
    // 1. ofr.next==0, i.e. we're at the end of the book
    // 2. offers[ofr.next] does not exist, i.e. we're at the end of the local cache
    const nextOffer = semibook.offers.get(ofr.next);
    if (nextOffer) {
      nextOffer.prev = ofr.prev;
    }

    semibook.offers.delete(id);
    return ofr;
  } else {
    return null;
  }
  /* Insert an offer in a {offerMap,bestOffer} semibook and keep the structure in a coherent state */
};

// Assumes ofr.prev and ofr.next are present in local OB copy.
// Assumes id is not already in book;
const insertOffer = (semibook: semibook, id: number, ofr: Offer) => {
  semibook.offers.set(id, ofr);
  if (ofr.prev === 0) {
    semibook.best = ofr.id;
  } else {
    semibook.offers.get(ofr.prev).next = id;
  }

  if (ofr.next !== 0) {
    semibook.offers.get(ofr.next).prev = id;
  }
};

// return id of offer next to offerId, according to cache.
// note that offers[offers[offerId].next] may be not exist!
// throws if offerId is not found
const getNext = ({ offers, best }: semibook, offerId: number) => {
  if (offerId === 0) {
    return best;
  } else {
    if (!offers.get(offerId)) {
      throw Error(
        "Trying to get next of an offer absent from local orderbook copy"
      );
    } else {
      return offers.get(offerId).next;
    }
  }
};

/* Turn {bestOffer,offerMap} into an offer array */
const mapToArray = (best: number, offers: Map<number, Offer>) => {
  const ary = [];

  if (best !== 0) {
    let latest = offers.get(best);
    do {
      ary.push(latest);
      latest = offers.get(latest.next);
    } while (typeof latest !== "undefined");
  }
  return ary;
};
