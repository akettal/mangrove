import * as ethers from "ethers";
import { BigNumber } from "ethers"; // syntactic sugar
import { Bigish, typechain } from "./types";
import Mangrove from "./mangrove";
import MgvToken from "./mgvtoken";
import { OrderCompleteEvent } from "./types/typechain/Mangrove";
import Semibook from "./semibook";

let canConstructMarket = false;

const MAX_MARKET_ORDER_GAS = 6500000;

/* Note on big.js:
ethers.js's BigNumber (actually BN.js) only handles integers
big.js handles arbitrary precision decimals, which is what we want
for more on big.js vs decimals.js vs. bignumber.js (which is *not* ethers's BigNumber):
  github.com/MikeMcl/big.js/issues/45#issuecomment-104211175
*/
import Big from "big.js";
Big.DP = 20; // precision when dividing
Big.RM = Big.roundHalfUp; // round to nearest

export const bookOptsDefault: Market.BookOptions = {
  maxOffers: Semibook.DEFAULT_MAX_OFFERS,
};

import type { Awaited } from "ts-essentials";
import * as TCM from "./types/typechain/Mangrove";

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Market {
  export type MgvReader = typechain.MgvReader;
  export type OrderResult = { got: Big; gave: Big; penalty: Big };
  export type BookSubscriptionEvent =
    | ({ name: "OfferWrite" } & TCM.OfferWriteEvent)
    | ({ name: "OfferFail" } & TCM.OfferFailEvent)
    | ({ name: "OfferSuccess" } & TCM.OfferSuccessEvent)
    | ({ name: "OfferRetract" } & TCM.OfferRetractEvent)
    | ({ name: "SetGasbase" } & TCM.SetGasbaseEvent);

  export type TradeParams = { slippage?: number } & (
    | { volume: Bigish; price: Bigish | null }
    | { total: Bigish; price: Bigish | null }
    | { wants: Bigish; gives: Bigish; fillWants?: boolean }
  );

  /**
   * Specification of how much volume to (potentially) trade on the market.
   *
   * `{given:100, what:"base", to:"buy"}` means buying 100 base tokens.
   *
   * `{given:10, what:"quote", to:"sell"})` means selling 10 quote tokens.
   */
  export type VolumeParams = Semibook.VolumeParams & {
    /** Whether `given` is the market's base or quote. */
    what: "base" | "quote";
  };

  /**
   * Options that control how the book cache behaves.
   */
  export type BookOptions = {
    /** The maximum number of offers to store in the cache.
     *
     * `maxOffers` and `desiredPrice` are mutually exclusive.
     */
    maxOffers?: number;
    /** The number of offers to fetch in one call.
     *
     * Defaults to `maxOffers` if it is set and positive; Otherwise `Semibook.DEFAULT_MAX_OFFERS` is used. */
    chunkSize?: number;
    /** The price that is expected to be used in calls to the market.
     * The cache will initially contain all offers with this price or better.
     * This can be useful in order to ensure a good pivot is readily available.
     *
     * `maxOffers` and `desiredPrice` are mutually exclusive.
     */
    desiredPrice?: Bigish;
    /**
     * The volume that is expected to be used in trades on the market.
     */
    desiredVolume?: VolumeParams;
  };

  export type Offer = {
    id: number;
    prev: number | undefined;
    next: number | undefined;
    gasprice: number;
    maker: string;
    gasreq: number;
    offer_gasbase: number;
    wants: Big;
    gives: Big;
    volume: Big;
    price: Big;
  };

  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace BookReturns {
    type _BookReturns = Awaited<
      ReturnType<Market.MgvReader["functions"]["offerList"]>
    >;
    export type Indices = _BookReturns[1];
    export type Offers = _BookReturns[2];
    export type Details = _BookReturns[3];
  }

  export type BookSubscriptionCbArgument = {
    ba: "asks" | "bids";
    offer: Offer;
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

  export type MarketCallback<T> = (
    cbArg: BookSubscriptionCbArgument,
    event?: BookSubscriptionEvent,
    ethersLog?: ethers.providers.Log
  ) => T;
  export type StorableMarketCallback = MarketCallback<any>;
  export type MarketFilter = MarketCallback<boolean>;
  export type SubscriptionParam =
    | { type: "multiple" }
    | {
        type: "once";
        ok: (...a: any[]) => any;
        ko: (...a: any[]) => any;
        filter?: (...a: any[]) => boolean;
      };

  // FIXME: This name is misleading, since you're only getting prefixes of the offer lists.
  // FIXME: Perhaps we should expose Semibook instead of arrays? Semibooks carry more information.
  /**
   * @deprecated This has been subsumed by the `Book` type
   */
  export type MarketBook = { asks: Offer[]; bids: Offer[] };

  export type Book = { asks: Semibook; bids: Semibook };

  export type VolumeEstimate = {
    estimatedVolume: Big;
    givenResidue: Big;
  };
}

/**
 * The Market class focuses on a Mangrove market.
 * On-chain, markets are implemented as two offer lists,
 * one for asks (base,quote), the other for bids (quote,base).
 *
 * Market initialization needs to store the network name, so you cannot
 * directly use the constructor. Instead of `new Market(...)`, do
 *
 * `await Market.connect(...)`
 */
class Market {
  mgv: Mangrove;
  base: MgvToken;
  quote: MgvToken;
  #subscriptions: Map<Market.StorableMarketCallback, Market.SubscriptionParam>;
  #asksSemibook: Semibook;
  #bidsSemibook: Semibook;
  #book: Market.MarketBook;
  #initClosure?: () => Promise<void>;

  static async connect(params: {
    mgv: Mangrove;
    base: string;
    quote: string;
    bookOptions?: Market.BookOptions;
  }): Promise<Market> {
    canConstructMarket = true;
    const market = new Market(params);
    canConstructMarket = false;
    if (params["noInit"]) {
      market.#initClosure = () => {
        return market.#initialize(params.bookOptions);
      };
    } else {
      await market.#initialize(params.bookOptions);
    }

    return market;
  }

  /* Stop listening to events from mangrove */
  disconnect(): void {
    this.#asksSemibook.disconnect();
    this.#bidsSemibook.disconnect();
  }

  /**
   * Initialize a new `params.base`:`params.quote` market.
   *
   * `params.mgv` will be used as mangrove instance
   */
  private constructor(params: { mgv: Mangrove; base: string; quote: string }) {
    if (!canConstructMarket) {
      throw Error(
        "Mangrove Market must be initialized async with Market.connect (constructors cannot be async)"
      );
    }
    this.#subscriptions = new Map();
    this.mgv = params.mgv;

    this.base = this.mgv.token(params.base);
    this.quote = this.mgv.token(params.quote);

    this.#book = { asks: [], bids: [] };
  }

  initialize(): Promise<void> {
    if (typeof this.#initClosure === "undefined") {
      throw new Error("Cannot initialize already initialized market.");
    } else {
      const initClosure = this.#initClosure;
      this.#initClosure = undefined;
      return initClosure();
    }
  }

  async #initialize(opts: Market.BookOptions = bookOptsDefault): Promise<void> {
    const semibookDesiredVolume =
      opts.desiredVolume === undefined
        ? undefined
        : { given: opts.desiredVolume.given, to: opts.desiredVolume.to };
    const isVolumeDesiredForAsks =
      opts.desiredVolume !== undefined &&
      ((opts.desiredVolume.what === "base" &&
        opts.desiredVolume.to === "buy") ||
        (opts.desiredVolume.what === "quote" &&
          opts.desiredVolume.to === "sell"));
    const isVolumeDesiredForBids =
      opts.desiredVolume !== undefined &&
      ((opts.desiredVolume.what === "base" &&
        opts.desiredVolume.to === "sell") ||
        (opts.desiredVolume.what === "quote" &&
          opts.desiredVolume.to === "buy"));

    const getSemibookOpts: (ba: "bids" | "asks") => Semibook.Options = (
      ba
    ) => ({
      maxOffers: opts.maxOffers,
      chunkSize: opts.chunkSize,
      desiredPrice: opts.desiredPrice,
      desiredVolume:
        (ba === "asks" && isVolumeDesiredForAsks) ||
        (ba === "bids" && isVolumeDesiredForBids)
          ? semibookDesiredVolume
          : undefined,
    });

    const asksSemibookPromise = Semibook.connect(
      this,
      "asks",
      (e) => this.#semibookCallback(e),
      getSemibookOpts("asks")
    );
    const bidsSemibookPromise = Semibook.connect(
      this,
      "bids",
      (e) => this.#semibookCallback(e),
      getSemibookOpts("bids")
    );

    this.#asksSemibook = await asksSemibookPromise;
    this.#bidsSemibook = await bidsSemibookPromise;

    this.#updateBook("asks");
    this.#updateBook("bids");
  }

  #semibookCallback({
    cbArg,
    event,
    ethersLog: ethersLog,
  }: Semibook.Event): void {
    this.#updateBook(cbArg.ba);
    for (const [cb, params] of this.#subscriptions) {
      if (params.type === "once") {
        if (!("filter" in params) || params.filter(cbArg, event, ethersLog)) {
          this.#subscriptions.delete(cb);
          Promise.resolve(cb(cbArg, event, ethersLog)).then(
            params.ok,
            params.ko
          );
        }
      } else {
        cb(cbArg, event, ethersLog);
      }
    }
  }

  #updateBook(ba: "bids" | "asks"): void {
    this.#book[ba] = Array.from(
      ba === "asks" ? this.#asksSemibook : this.#bidsSemibook
    );
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
   * @deprecated Subsumed by `getBook` which returns the more versatile `Book` type.
   */
  book(): Market.MarketBook {
    return this.#book;
  }

  /**
   * Return the semibooks of this market
   */
  getBook(): Market.Book {
    return {
      asks: this.#asksSemibook,
      bids: this.#bidsSemibook,
    };
  }

  /**
   * Return the asks or bids semibook
   */
  getSemibook(ba: "bids" | "asks"): Semibook {
    return ba === "asks" ? this.#asksSemibook : this.#bidsSemibook;
  }

  async requestBook(
    opts: Market.BookOptions = bookOptsDefault
  ): Promise<Market.MarketBook> {
    const asksPromise = this.#asksSemibook.requestOfferListPrefix(opts);
    const bidsPromise = this.#bidsSemibook.requestOfferListPrefix(opts);
    return {
      asks: await asksPromise,
      bids: await bidsPromise,
    };
  }

  async isActive(): Promise<boolean> {
    const config = await this.config();
    return config.asks.active && config.bids.active;
  }

  /** Given a price, find the id of the immediately-better offer in the
   * book. If there is no offer with a better price, `undefined` is returned.
   */
  async getPivotId(
    ba: "asks" | "bids",
    price: Bigish
  ): Promise<number | undefined> {
    return ba === "asks"
      ? await this.#asksSemibook.getPivotId(price)
      : await this.#bidsSemibook.getPivotId(price);
  }

  async getOfferProvision(
    ba: "bids" | "asks",
    gasreq: number,
    gasprice: number
  ): Promise<Big> {
    const { outbound_tkn, inbound_tkn } = this.getOutboundInbound(ba);
    const prov = await this.mgv.readerContract.getProvision(
      outbound_tkn.address,
      inbound_tkn.address,
      gasreq,
      gasprice
    );
    return this.mgv.fromUnits(prov, 18);
  }

  getBidProvision(gasreq: number, gasprice: number): Promise<Big> {
    return this.getOfferProvision("bids", gasreq, gasprice);
  }
  getAskProvision(gasreq: number, gasprice: number): Promise<Big> {
    return this.getOfferProvision("asks", gasreq, gasprice);
  }

  bidInfo(offerId: number): Promise<Market.Offer> {
    return this.offerInfo("bids", offerId);
  }

  askInfo(offerId: number): Promise<Market.Offer> {
    return this.offerInfo("asks", offerId);
  }

  /** Returns struct containing offer details in the current market */
  async offerInfo(ba: "bids" | "asks", offerId: number): Promise<Market.Offer> {
    return ba === "asks"
      ? this.#asksSemibook.offerInfo(offerId)
      : this.#bidsSemibook.offerInfo(offerId);
  }

  /**
   * Market buy order. Will attempt to buy base token using quote tokens.
   * Params can be of the form:
   * - `{volume,price}`: buy `volume` base tokens for a max average price of `price`. Set `price` to null for a true market order. `fillWants` will be true.
   * - `{total,price}` : buy as many base tokens as possible using up to `total` quote tokens, with a max average price of `price`. Set `price` to null for a true market order. `fillWants` will be false.
   * - `{wants,gives,fillWants?}`: accept implicit max average price of `gives/wants`
   *
   * In addition, `slippage` defines an allowed slippage in % of the amount of quote token.
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
  buy(params: Market.TradeParams): Promise<Market.OrderResult> {
    let _wants, _gives, fillWants;
    if ("price" in params) {
      if ("volume" in params) {
        _wants = Big(params.volume);
        _gives =
          params.price === null
            ? Big(2).pow(256).minus(1)
            : _wants.mul(params.price);
        fillWants = true;
      } else {
        _gives = Big(params.total);
        _wants = params.price === null ? 0 : _gives.div(params.price);
        fillWants = false;
      }
    } else {
      _wants = Big(params.wants);
      _gives = Big(params.gives);
      fillWants = "fillWants" in params ? params.fillWants : true;
    }

    const slippage = validateSlippage(params.slippage);

    _gives = _gives.mul(100 + slippage).div(100);

    const wants = this.base.toUnits(_wants);
    const gives = this.quote.toUnits(_gives);

    return this.#marketOrder({ gives, wants, orderType: "buy", fillWants });
  }

  /**
   * Market sell order. Will attempt to sell base token for quote tokens.
   * Params can be of the form:
   * - `{volume,price}`: sell `volume` base tokens for a min average price of `price`. Set `price` to null for a true market order. `fillWants` will be false.
   * - `{total,price}` : sell as many base tokens as possible buying up to `total` quote tokens, with a min average price of `price`. Set `price` to null. `fillWants` will be true.
   * - `{wants,gives,fillWants?}`: accept implicit min average price of `gives/wants`. `fillWants` will be false by default.
   *
   * In addition, `slippage` defines an allowed slippage in % of the amount of quote token.
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
  sell(params: Market.TradeParams): Promise<Market.OrderResult> {
    let _wants, _gives, fillWants;
    if ("price" in params) {
      if ("volume" in params) {
        _gives = Big(params.volume);
        _wants = params.price === null ? 0 : _gives.mul(params.price);
        fillWants = false;
      } else {
        _wants = Big(params.total);
        _gives =
          params.price === null
            ? Big(2).pow(256).minus(1)
            : _wants.div(params.price);
        fillWants = true;
      }
    } else {
      _wants = Big(params.wants);
      _gives = Big(params.gives);
      fillWants = "fillWants" in params ? params.fillWants : false;
    }

    const slippage = validateSlippage(params.slippage);

    _wants = _wants.mul(100 - slippage).div(100);

    const gives = this.base.toUnits(_gives);
    const wants = this.quote.toUnits(_wants);

    return this.#marketOrder({ wants, gives, orderType: "sell", fillWants });
  }

  /**
   * Low level Mangrove market order.
   * If `orderType` is `"buy"`, the base/quote market will be used,
   *
   * If `orderType` is `"sell"`, the quote/base market will be used,
   *
   * `fillWants` defines whether the market order stops immediately once `wants` tokens have been purchased or whether it tries to keep going until `gives` tokens have been spent.
   *
   * In addition, `slippage` defines an allowed slippage in % of the amount of quote token.
   *
   * Returns a promise for market order result after 1 confirmation.
   * Will throw on same conditions as ethers.js `transaction.wait`.
   */
  async #marketOrder({
    wants,
    gives,
    orderType,
    fillWants,
  }: {
    wants: ethers.BigNumber;
    gives: ethers.BigNumber;
    orderType: "buy" | "sell";
    fillWants: boolean;
  }): Promise<Market.OrderResult> {
    const [outboundTkn, inboundTkn] =
      orderType === "buy" ? [this.base, this.quote] : [this.quote, this.base];

    const gasLimit = await this.estimateGas(orderType, wants);
    const response = await this.mgv.contract.marketOrder(
      outboundTkn.address,
      inboundTkn.address,
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
        if ((evt as OrderCompleteEvent).args.taker === receipt.from) {
          result = evt;
        }
      }
    }
    if (!result) {
      throw Error("market order went wrong");
    }
    const got_bq = orderType === "buy" ? "base" : "quote";
    const gave_bq = orderType === "buy" ? "quote" : "base";
    return {
      got: this[got_bq].fromUnits(result.args.takerGot),
      gave: this[gave_bq].fromUnits(result.args.takerGave),
      penalty: this.mgv.fromUnits(result.args.penalty, 18),
    };
  }

  async estimateGas(bs: "buy" | "sell", volume: BigNumber): Promise<BigNumber> {
    const rawConfig =
      bs === "buy"
        ? await this.#asksSemibook.getRawConfig()
        : await this.#bidsSemibook.getRawConfig();
    const estimation = rawConfig.local.offer_gasbase.add(
      volume.div(rawConfig.local.density)
    );
    if (estimation.gt(MAX_MARKET_ORDER_GAS)) {
      return BigNumber.from(MAX_MARKET_ORDER_GAS);
    } else {
      return estimation;
    }
  }

  /**
   * Volume estimator.
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
  async estimateVolume(
    params: Market.VolumeParams
  ): Promise<Market.VolumeEstimate> {
    if (
      (params.what === "base" && params.to === "buy") ||
      (params.what === "quote" && params.to === "sell")
    ) {
      return await this.#asksSemibook.estimateVolume(params);
    } else {
      return await this.#bidsSemibook.estimateVolume(params);
    }
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
  async config(): Promise<{
    asks: Mangrove.LocalConfig;
    bids: Mangrove.LocalConfig;
  }> {
    const asksConfigPromise = this.#asksSemibook.getConfig();
    const bidsConfigPromise = this.#bidsSemibook.getConfig();
    return {
      asks: await asksConfigPromise,
      bids: await bidsConfigPromise,
    };
  }

  /** Pretty prints the current state of the asks of the market */
  consoleAsks(
    filter?: Array<
      | "id"
      | "prev"
      | "next"
      | "gasprice"
      | "maker"
      | "gasreq"
      | "offer_gasbase"
      | "wants"
      | "gives"
      | "volume"
      | "price"
    >
  ): void {
    let column = [];
    column = filter ? filter : ["id", "maker", "volume", "price"];
    this.prettyPrint("asks", column);
  }

  /** Pretty prints the current state of the bids of the market */
  consoleBids(
    filter?: Array<
      | "id"
      | "prev"
      | "next"
      | "gasprice"
      | "maker"
      | "gasreq"
      | "offer_gasbase"
      | "wants"
      | "gives"
      | "volume"
      | "price"
    >
  ): void {
    let column = [];
    column = filter ? filter : ["id", "maker", "volume", "price"];
    this.prettyPrint("bids", column);
  }

  /** Pretty prints the current state of the asks or bids of the market */
  prettyPrint(
    ba: "bids" | "asks",
    filter: Array<
      | "id"
      | "prev"
      | "next"
      | "gasprice"
      | "maker"
      | "gasreq"
      | "overhead_gasbase"
      | "offer_gasbase"
      | "wants"
      | "gives"
      | "volume"
      | "price"
    >
  ): void {
    const offers = ba === "bids" ? this.#book.bids : this.#book.asks;
    console.table(offers, filter);
  }

  /**
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
   * market.subscribe((event,utils) => console.log(event.type, utils.book()))
   * ```
   *
   * @note Only one subscription may be active at a time.
   */
  subscribe(cb: Market.MarketCallback<void>): void {
    this.#subscriptions.set(cb, { type: "multiple" });
  }

  /**
   *  Returns a promise which is fulfilled after execution of the callback.
   */
  async once<T>(
    cb: Market.MarketCallback<T>,
    filter?: Market.MarketFilter
  ): Promise<T> {
    return new Promise((ok, ko) => {
      const params: Market.SubscriptionParam = { type: "once", ok, ko };
      if (typeof filter !== "undefined") {
        params.filter = filter;
      }
      this.#subscriptions.set(cb as Market.StorableMarketCallback, params);
    });
  }

  /* Stop calling a user-provided function on book-related events. */
  unsubscribe(cb: Market.StorableMarketCallback): void {
    this.#subscriptions.delete(cb);
  }

  /** Determine which token will be Mangrove's outbound/inbound depending on whether you're working with bids or asks. */
  getOutboundInbound(ba: "bids" | "asks"): {
    outbound_tkn: MgvToken;
    inbound_tkn: MgvToken;
  } {
    return Market.getOutboundInbound(ba, this.base, this.quote);
  }

  /** Determine which token will be Mangrove's outbound/inbound depending on whether you're working with bids or asks. */
  static getOutboundInbound(
    ba: "bids" | "asks",
    base: MgvToken,
    quote: MgvToken
  ): {
    outbound_tkn: MgvToken;
    inbound_tkn: MgvToken;
  } {
    return {
      outbound_tkn: ba === "asks" ? base : quote,
      inbound_tkn: ba === "asks" ? quote : base,
    };
  }

  /** Determine whether gives or wants will be baseVolume/quoteVolume depending on whether you're working with bids or asks. */
  static getBaseQuoteVolumes(
    ba: "asks" | "bids",
    gives: Big,
    wants: Big
  ): { baseVolume: Big; quoteVolume: Big } {
    return {
      baseVolume: ba === "asks" ? gives : wants,
      quoteVolume: ba === "asks" ? wants : gives,
    };
  }

  /** Determine the price from gives or wants depending on whether you're working with bids or asks. */
  static getPrice(ba: "asks" | "bids", gives: Big, wants: Big): Big {
    const { baseVolume, quoteVolume } = Market.getBaseQuoteVolumes(
      ba,
      gives,
      wants
    );
    return quoteVolume.div(baseVolume);
  }

  /** Determine the wants from gives and price depending on whether you're working with bids or asks. */
  static getWantsForPrice(ba: "asks" | "bids", gives: Big, price: Big): Big {
    return ba === "asks" ? gives.mul(price) : gives.div(price);
  }

  /** Determine the gives from wants and price depending on whether you're working with bids or asks. */
  static getGivesForPrice(ba: "asks" | "bids", wants: Big, price: Big): Big {
    return ba === "asks" ? wants.div(price) : wants.mul(price);
  }
}

const validateSlippage = (slippage = 0) => {
  if (typeof slippage === "undefined") {
    return 0;
  } else if (slippage > 100 || slippage < 0) {
    throw new Error("slippage should be a number between 0 and 100");
  }
  return slippage;
};

export default Market;
