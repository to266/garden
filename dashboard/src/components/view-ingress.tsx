/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import React from "react"
import styled from "@emotion/styled"
import { ExternalLink } from "./links"
import { ServiceIngress } from "@garden-io/core/build/src/types/service"
import { truncateMiddle, getLinkUrl } from "../util/helpers"
import { ActionIcon } from "./action-icon"
import { useUiState } from "../hooks"
import { Frame } from "./frame"

const ViewIngress = styled.div``

const LinkContainer = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  position: absolute;
  top: 1.5rem;
  right: 1rem;
  background: white;
  padding: 0.5rem;
  border-radius: 4px;
  border-bottom-right-radius: 0;
  border-top-left-radius: 0;
  box-shadow: 0px 6px 18px rgba(0, 0, 0, 0.06);
`

type FrameWrapperProps = {
  width?: string
  height?: string
}

const FrameWrapper = styled.div<FrameWrapperProps>`
  display: flex;
  flex-direction: column;
  width: ${(props) => props.width || "50vw"};
  height: ${(props) => props.height || "96.5vh"};
  background: white;
  box-shadow: 0px 6px 18px rgba(0, 0, 0, 0.06);
  border-radius: 4px;
  min-height: 0;
  overflow: hidden;
`

interface ViewIngressProp {
  ingress: ServiceIngress
  height?: string
  width?: string
}

export default ({ ingress, height, width }: ViewIngressProp) => {
  const {
    actions: { selectIngress },
  } = useUiState()

  const removeSelectedIngress = () => {
    selectIngress(null)
  }

  const url = getLinkUrl(ingress)

  return (
    <ViewIngress>
      <LinkContainer>
        <ExternalLink href={url} target="_blank">
          {truncateMiddle(url)}
        </ExternalLink>
        <ActionIcon onClick={removeSelectedIngress} iconClassName="window-close" />
      </LinkContainer>
      <FrameWrapper height={height} width={width}>
        <Frame src={url} />
      </FrameWrapper>
    </ViewIngress>
  )
}
