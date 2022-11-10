import {makeAutoObservable, runInAction} from 'mobx'
import * as GetPostThread from '../../third-party/api/src/client/types/app/bsky/feed/getPostThread'
import {AtUri} from '../../third-party/uri'
import _omit from 'lodash.omit'
import {RootStoreModel} from './root-store'
import * as apilib from '../lib/api'

function* reactKeyGenerator(): Generator<string> {
  let counter = 0
  while (true) {
    yield `item-${counter++}`
  }
}

export class PostThreadViewPostMyStateModel {
  repost?: string
  upvote?: string
  downvote?: string

  constructor() {
    makeAutoObservable(this)
  }
}

export class PostThreadViewPostModel implements GetPostThread.Post {
  // ui state
  _reactKey: string = ''
  _depth = 0
  _isHighlightedPost = false

  // data
  uri: string = ''
  cid: string = ''
  author: GetPostThread.User = {
    did: '',
    handle: '',
    displayName: '',
    declaration: {cid: '', actorType: ''},
  }
  record: Record<string, unknown> = {}
  embed?:
    | GetPostThread.RecordEmbed
    | GetPostThread.ExternalEmbed
    | GetPostThread.UnknownEmbed
  parent?: PostThreadViewPostModel
  replyCount: number = 0
  replies?: PostThreadViewPostModel[]
  repostCount: number = 0
  upvoteCount: number = 0
  downvoteCount: number = 0
  indexedAt: string = ''
  myState = new PostThreadViewPostMyStateModel()

  // added data
  replyingToAuthor?: string

  constructor(
    public rootStore: RootStoreModel,
    reactKey: string,
    v?: GetPostThread.Post,
  ) {
    makeAutoObservable(this, {rootStore: false})
    this._reactKey = reactKey
    if (v) {
      Object.assign(this, _omit(v, 'parent', 'replies', 'myState')) // replies and parent are handled via assignTreeModels
      if (v.myState) {
        Object.assign(this.myState, v.myState)
      }
    }
  }

  assignTreeModels(
    keyGen: Generator<string>,
    v: GetPostThread.Post,
    includeParent = true,
    includeChildren = true,
  ) {
    // parents
    if (includeParent && v.parent) {
      // TODO: validate .record
      const parentModel = new PostThreadViewPostModel(
        this.rootStore,
        keyGen.next().value,
        v.parent,
      )
      parentModel._depth = this._depth - 1
      if (v.parent.parent) {
        parentModel.assignTreeModels(keyGen, v.parent, true, false)
      }
      this.parent = parentModel
    }
    if (v.parent?.author.handle) {
      this.replyingToAuthor = v.parent.author.handle
    }
    // replies
    if (includeChildren && v.replies) {
      const replies = []
      for (const item of v.replies) {
        // TODO: validate .record
        const itemModel = new PostThreadViewPostModel(
          this.rootStore,
          keyGen.next().value,
          item,
        )
        itemModel._depth = this._depth + 1
        if (item.replies) {
          itemModel.assignTreeModels(keyGen, item, false, true)
        }
        replies.push(itemModel)
      }
      this.replies = replies
    }
  }

  async _clearVotes() {
    if (this.myState.upvote) {
      await apilib.unupvote(this.rootStore, this.myState.upvote)
      runInAction(() => {
        this.upvoteCount--
        this.myState.upvote = undefined
      })
    }
    if (this.myState.downvote) {
      await apilib.undownvote(this.rootStore, this.myState.downvote)
      runInAction(() => {
        this.downvoteCount--
        this.myState.downvote = undefined
      })
    }
  }

  async toggleUpvote() {
    const wasntUpvoted = !this.myState.upvote
    await this._clearVotes()
    if (wasntUpvoted) {
      const res = await apilib.upvote(this.rootStore, this.uri, this.cid)
      runInAction(() => {
        this.upvoteCount++
        this.myState.upvote = res.uri
      })
    }
  }

  async toggleDownvote() {
    const wasntDownvoted = !this.myState.downvote
    await this._clearVotes()
    if (wasntDownvoted) {
      const res = await apilib.downvote(this.rootStore, this.uri, this.cid)
      runInAction(() => {
        this.downvoteCount++
        this.myState.downvote = res.uri
      })
    }
  }

  async toggleRepost() {
    if (this.myState.repost) {
      await apilib.unrepost(this.rootStore, this.myState.repost)
      runInAction(() => {
        this.repostCount--
        this.myState.repost = undefined
      })
    } else {
      const res = await apilib.repost(this.rootStore, this.uri, this.cid)
      runInAction(() => {
        this.repostCount++
        this.myState.repost = res.uri
      })
    }
  }
}

export class PostThreadViewModel {
  // state
  isLoading = false
  isRefreshing = false
  hasLoaded = false
  error = ''
  resolvedUri = ''
  params: GetPostThread.QueryParams

  // data
  thread?: PostThreadViewPostModel

  constructor(
    public rootStore: RootStoreModel,
    params: GetPostThread.QueryParams,
  ) {
    makeAutoObservable(
      this,
      {
        rootStore: false,
        params: false,
      },
      {autoBind: true},
    )
    this.params = params
  }

  get hasContent() {
    return typeof this.thread !== 'undefined'
  }

  get hasError() {
    return this.error !== ''
  }

  // public api
  // =

  /**
   * Load for first render
   */
  async setup() {
    if (!this.resolvedUri) {
      await this._resolveUri()
    }
    if (this.hasContent) {
      await this.update()
    } else {
      await this._load()
    }
  }

  /**
   * Reset and load
   */
  async refresh() {
    await this._load(true)
  }

  /**
   * Update content in-place
   */
  async update() {
    // NOTE: it currently seems that a full load-and-replace works fine for this
    //       if the UI loses its place or has jarring re-arrangements, replace this
    //       with a more in-place update
    this._load()
  }

  // state transitions
  // =

  private _xLoading(isRefreshing = false) {
    this.isLoading = true
    this.isRefreshing = isRefreshing
    this.error = ''
  }

  private _xIdle(err: string = '') {
    this.isLoading = false
    this.isRefreshing = false
    this.hasLoaded = true
    this.error = err
  }

  // loader functions
  // =

  private async _resolveUri() {
    const urip = new AtUri(this.params.uri)
    if (!urip.host.startsWith('did:')) {
      urip.host = await this.rootStore.resolveName(urip.host)
    }
    runInAction(() => {
      this.resolvedUri = urip.toString()
    })
  }

  private async _load(isRefreshing = false) {
    this._xLoading(isRefreshing)
    try {
      const res = await this.rootStore.api.app.bsky.feed.getPostThread(
        Object.assign({}, this.params, {uri: this.resolvedUri}),
      )
      this._replaceAll(res)
      this._xIdle()
    } catch (e: any) {
      this._xIdle(`Failed to load thread: ${e.toString()}`)
    }
  }

  private _replaceAll(res: GetPostThread.Response) {
    // TODO: validate .record
    const keyGen = reactKeyGenerator()
    const thread = new PostThreadViewPostModel(
      this.rootStore,
      keyGen.next().value,
      res.data.thread,
    )
    thread._isHighlightedPost = true
    thread.assignTreeModels(keyGen, res.data.thread)
    this.thread = thread
  }
}
