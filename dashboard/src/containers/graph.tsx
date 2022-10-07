/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import React, { useEffect } from "react"
import styled from "@emotion/styled"
import { StackGraph } from "../components/graph"
import PageError from "../components/page-error"
import { TaskState } from "../contexts/api"
import { StackGraphSupportedFilterKeys, EntityResultSupportedTypes } from "../contexts/ui"
import EntityResult from "./entity-result"
import Spinner from "../components/spinner"
import { Filters } from "../components/group-filter"
import { capitalize } from "lodash"
import { RenderedNode } from "@garden-io/core/build/src/config-graph"
import { GraphOutput } from "@garden-io/core/build/src/commands/get/get-graph"
import { loadGraph } from "../api/actions"
import { getTestKey } from "../util/helpers"
import { useApi, useUiState } from "../hooks"
import { colors } from "../styles/variables"

const Wrapper = styled.div`
  position: relative;
  width: 100%;
  background-color: ${colors.gardenWhite};
`

const cardStyle = {
  position: "absolute",
  top: "0",
  right: "1.5rem",
  minWidth: "20rem",
  maxWidth: "35rem",
  maxHeight: "calc(100vh - 8rem)",
  overflowY: "auto",
}

export interface StackGraphNode extends RenderedNode {
  status?: TaskState
  disabled: boolean
}
export interface GraphOutputWithNodeStatus extends GraphOutput {
  nodes: StackGraphNode[]
}

export default () => {
  const {
    dispatch,
    store: { entities, requestStates },
  } = useApi()

  const { project, modules, services, tests, tasks, graph } = entities

  const {
    actions: { selectGraphNode, stackGraphToggleItemsView, clearGraphNodeSelection },
    state: {
      selectedGraphNode,
      stackGraph: { filters },
    },
  } = useUiState()

  useEffect(() => {
    const fetchData = async () => loadGraph(dispatch)

    if (!requestStates.graph.initLoadComplete) {
      fetchData()
    }
  }, [dispatch, requestStates.graph.initLoadComplete])

  if (requestStates.graph.error) {
    return <PageError error={requestStates.graph.error} />
  }

  if (!requestStates.graph.initLoadComplete) {
    return <Spinner />
  }

  const nodesWithStatus: StackGraphNode[] = graph.nodes.map((node) => {
    let taskState: TaskState = "taskComplete"
    let disabled = modules[node.name]?.disabled
    switch (node.type) {
      case "deploy":
        const service = services[node.name]
        disabled = service.config.disabled || service.config.moduleDisabled
        taskState = service.taskState
        break
      case "build":
        taskState = modules[node.name].taskState
        break
      case "run":
        const task = tasks[node.name]
        disabled = task.config.disabled || task.config.moduleDisabled
        taskState = task.taskState
        break
      case "test":
        const test = tests[getTestKey({ testName: node.name, moduleName: node.moduleName })]
        disabled = test.config.disabled || test.config.moduleDisabled
        taskState = test.taskState
        break
    }
    return { ...node, disabled, status: taskState }
  })

  let graphWithStatus: GraphOutputWithNodeStatus = { nodes: nodesWithStatus, relationships: graph.relationships }

  let moreInfoPane: React.ReactNode = null
  if (selectedGraphNode && graph) {
    const node = graph.nodes.find((n) => n.key === selectedGraphNode)
    if (node) {
      moreInfoPane = (
        <EntityResult
          name={node.name}
          type={node.type as EntityResultSupportedTypes}
          moduleName={node.moduleName}
          onClose={clearGraphNodeSelection}
          cardProps={{ style: cardStyle }}
        />
      )
    }
  }

  const graphFilters = Object.keys(filters).reduce((allGroupFilters, type) => {
    return {
      ...allGroupFilters,
      [type]: {
        label: capitalize(type),
        selected: filters[type],
      },
    }
  }, {}) as Filters<StackGraphSupportedFilterKeys>

  return (
    <Wrapper>
      <StackGraph
        onGraphNodeSelected={selectGraphNode}
        selectedGraphNode={selectedGraphNode}
        graph={graphWithStatus}
        filters={graphFilters}
        onFilter={stackGraphToggleItemsView}
        isProcessing={project.taskGraphProcessing}
      />
      {moreInfoPane}
    </Wrapper>
  )
}
