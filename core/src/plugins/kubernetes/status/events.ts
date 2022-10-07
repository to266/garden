/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { KubeApi } from "../api"
import { KubernetesResource } from "../types"

export async function getResourceEvents(api: KubeApi, resource: KubernetesResource, minVersion?: number) {
  const fieldSelector =
    `involvedObject.apiVersion=${resource.apiVersion},` +
    `involvedObject.kind=${resource.kind},` +
    `involvedObject.name=${resource.metadata.name}`

  const namespace = resource.metadata?.namespace

  const res = namespace
    ? await api.core.listNamespacedEvent(namespace, undefined, undefined, undefined, fieldSelector)
    : await api.core.listEventForAllNamespaces(undefined, fieldSelector)

  const events = res.items
    // Filter out old events (relating to prior versions of the resource)
    .filter(
      (e) =>
        !minVersion ||
        !e.involvedObject!.resourceVersion ||
        parseInt(e.involvedObject!.resourceVersion, 10) > minVersion
    )

  return events
}
