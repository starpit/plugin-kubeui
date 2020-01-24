/*
 * Copyright 2020 IBM Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Debug from 'debug'
import { Table, Arguments, Streamable, Abortable, Watchable, Watcher, WatchPusher } from '@kui-shell/core'

import fqn from '../fqn'
import { Pair } from '../../../lib/view/formatTable'
import { formatOf, KubeOptions } from '../options'

const debug = Debug('plugin-kubeui/controller/watch/watcher')

/**
 * We might get partial rows back; they will have empty strings in the
 * value field.
 *
 */
function isFullRow(row: Pair[], nCols: number): boolean {
  return row.length === nCols && row.every(_ => _.value.length > 0)
}

/**
 * Return the pair of indices that define the extent of "full" rows
 * in the given table. Since we are streaming output from kubectl, we
 * get back partial rows in any one bundle of bits.
 *
 */
function findFullRows(arr: Pair[][], nCols: number): { firstFullIdx: number; lastFullIdx: number } {
  if (arr.length > 0) {
    // value=NAME means that this is a header column; we know this
    // because, below, we are in charge of the schema of the table!
    // skip over that here, because we want to find the interval of
    // "full" body rows, i.e. excluding the header row
    const startIdx = arr.findIndex(row => row.length === nCols && row[0].value !== 'NAME')

    if (startIdx >= 0) {
      for (let idx = startIdx; idx < arr.length; idx++) {
        if (isFullRow(arr[idx], nCols)) {
          // then we have found the \lower\ bound
          for (let jdx = arr.length - 1; jdx >= idx; jdx--) {
            if (isFullRow(arr[jdx], nCols)) {
              // and now we have found the /upper/ bound
              return { firstFullIdx: idx, lastFullIdx: jdx }
            }
          }

          // hmm, we couldn't find an upper bound, but we did find a
          // lower bound
          return { firstFullIdx: idx, lastFullIdx: idx }
        }
      }
    }
  }

  // hmm, then we couldn't even find a lower bound
  return { firstFullIdx: -1, lastFullIdx: -1 }
}

/** columns keys for our proto-table */
const keys = ['NAME', 'KIND', 'APIVERSION', 'NAMESPACE']

/**
 * Turn a raw proto table response into an row-array of column-array
 * of key-value `Pairs`.
 *
 */
function preprocessTable(rawTable: string): Pair[][] {
  return rawTable.split(/\n/).map(rawRow =>
    rawRow
      .split(/\s+/)
      .filter(_ => _)
      .map((value, colIdx) => ({ key: keys[colIdx], value }))
  )
}

/* type Update = { type: 'update'; row: Row }
type Header = { type: 'header'; header: Row }
type Offline = { type: 'offline'; key: string }
type AllOffline = { type: 'allOffline' }
type SomeUpdate = AllOffline | Header | Offline | Update */

class KubectlWatcher implements Abortable, Watcher {
  /**
   * We expect k columns; see the custom-columns below.
   * !! Keep this in sync with that !!
   */
  private readonly nCols = 4

  /**
   * We may get partial rows back from the underlying PTY; this is due
   * to our use of a streaming byte channel. We need to remember this
   * in-between callbacks for streaming chunks.
   *
   */
  private leftover: string

  /** the pty job we spawned to capture --watch-only output */
  private ptyJob: Abortable

  /** the table push API */
  private pusher: WatchPusher

  // private updateQueue: SomeUpdate[]

  /**
   * @param output This is the output format that the user desired. Below, we
   * formulate a watch query to the apiserver with a different
   * schema. We will need sufficient discriminants to index a row
   * update into an existing table. We cannot be certain that the
   * schema the *user* requested satisfies this requirement.
   */
  // eslint-disable-next-line no-useless-constructor
  public constructor(private readonly args: Arguments<KubeOptions>, private readonly output = formatOf(args)) {}

  /**
   * Our impl of `Abortable` for use by the table view
   *
   */
  public abort() {
    // we abort the associated pty, if we have one
    if (this.ptyJob) {
      this.ptyJob.abort()
      this.ptyJob = undefined
    }
  }

  /**
   * Our impl of the `onInit` streaming PTY API: the PTY calls us with
   * the PTY job (so that we can abort it, if we want). In return, we
   * give it a stream into which it pump data.
   *
   */
  private onPTYInit(ptyJob: Abortable) {
    // in response, we return a consumer of Streamable output; we only
    // handle string data types in this case
    debug('onPTYInit')
    this.ptyJob = ptyJob

    return async (_: Streamable) => {
      if (typeof _ === 'string') {
        // <-- strings flowing out of the PTY
        debug('streaming pty output', _)
        if (/not found/.test(_)) {
          this.pusher.allOffline()
          return
        }

        // rawData: what we will attempt to parse into a table; make
        // sure to use any residual leftover bits from previous
        // iterations
        const rawData = this.leftover ? this.leftover + _ : _

        // as a failsafe, since we just read this.leftover, clear it
        // out (read-once); we will then reestablish any residual
        // leftover immediately below
        this.leftover = undefined

        // here is where we turn the raw data into tabular data
        const allRows = preprocessTable(rawData)

        // find the interval of "full" rows; we may get back partial
        // rows, due to the way output streams back to us from the
        // underlying PTY
        const { firstFullIdx, lastFullIdx } = findFullRows(allRows, this.nCols)

        if (lastFullIdx < 0) {
          // then we got no full rows
          debug('no full rows', _)
          this.leftover = _
          return
        } else if (lastFullIdx < allRows.length - 1) {
          // the we got some trailing leftover bits
          const lastNewlineIdx = _.lastIndexOf('\n')
          this.leftover = _.slice(lastNewlineIdx)
        }

        // now process the full rows into table view updates
        const rows = allRows.slice(firstFullIdx, lastFullIdx + 1)
        const tables = await Promise.all(
          rows.map(async row => {
            try {
              const [{ value: name }, { value: kind }, { value: apiVersion }, { value: namespace }] = row

              const getCommand = `kubectl get ${fqn(apiVersion, kind, name, namespace)} ${
                this.output ? `-o ${this.output}` : ''
              }`
              // console.error('!! row fetch', getCommand)

              // this is where we fetch the table columns the user
              // requested; note our use of the "output" variable,
              // which (above) we defined to be the user's schema
              // request
              return this.args.REPL.qexec<Table>(getCommand).catch(() => {
                // error fetching the row data
                // const rowKey = fqn(apiVersion, kind, name, namespace)
                this.pusher.offline(name)
              })
            } catch (err) {
              console.error('error handling watched row', err)
            }
          })
        )

        // Now that we have fetched the user's data, we may have a
        // sense of the table schema, a.k.a. a "headerRow". Notes:
        // since we are using watch-only, this code is not currently
        // needed; if we every decide to use --watch, this could be
        // helpful.
        const tableWithHeader = tables.find(table => table && table.header)
        if (tableWithHeader) {
          // yup, we have a header; push it to the view
          this.pusher.header(tableWithHeader.header)
        }

        // based on the information we got back, 1) we push updates to
        // the table model; and 2) we may be able to discern that we
        // can stop watching
        tables.forEach(table => {
          if (table) {
            table.body.forEach(row => {
              // push an update to the table model
              this.pusher.update(row)
            })
          }
        })
      } else {
        console.error('unknown streamable type', _)
      }
    }
  }

  /**
   * Our impl of the `Watcher` API. This is the callback we will
   * receive from the table UI when it is ready for us to start
   * injecting updates to the table.
   *
   * We handle it by firing off a PTY to watch for subsequent changes
   * via `kubectl get --watch-only`.
   *
   */
  public async init(pusher: WatchPusher) {
    this.pusher = pusher

    // here, we initiate a kubectl watch, using a schema of our
    // choosing; we ask the PTY to stream output back to us, by using
    // the `onInit` API
    const command =
      this.args.command
        .replace(/^k(\s)/, 'kubectl$1')
        .replace(/--watch=true|-w=true|--watch-only=true|--watch|-w|--watch-only/g, '--watch')
        .replace(new RegExp(`(-o|--output)(\\s+|=)${this.output}`), '') +
      ` -o custom-columns=NAME:.metadata.name,KIND:.kind,APIVERSION:.apiVersion,NAMESPACE:.metadata.namespace`
    // ^^^^^ keep these in sync with nCols above !!

    this.args.REPL.qexec(`sendtopty ${command}`, this.args.block, undefined, {
      quiet: true,
      replSilence: true,
      echo: false,
      onInit: this.onPTYInit.bind(this) // <-- the PTY will call us back when it's ready to stream
    }).catch(err => {
      debug('pty error', err)
    })
  }
}

export default function doGetWatchTable(args: Arguments<KubeOptions>): Table & Watchable {
  return {
    body: [],
    watch: new KubectlWatcher(args) // <-- our watcher
  }
}
