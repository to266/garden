#!/bin/bash

# Script that downloads a release based on the version argument, and runs some simple tests to sanity check it.

garden_root=$(cd `dirname $0` && cd .. && pwd)
version=$1

# For pre-releases, trim the -N suffix for use in the downloaded file name and for version comparisons.
base_version=$(echo ${version} | sed -e "s/-.*//")

if [ ! "$version" ]; then
  echo "Version is missing"
  exit 1
fi

download_release() {
  if [ "$(uname -s)" = "Darwin" ]; then
    os=macos
  else
    os=`ldd 2>&1|grep musl >/dev/null && echo "alpine" || echo "linux"`
  fi

  platform=${os}-amd64
  filename="garden-${base_version}-${platform}.tar.gz"
  url="https://github.com/garden-io/garden/releases/download/${version}/${filename}"
  dir=${HOME}/.garden-release
  target_path=${dir}/bin

  echo "→ Downloading release ${version} to ${dir}"
  rm -rf $target_path
  mkdir -p $target_path
  cd $dir
  curl -sLO $url
  echo "→ Extracting to ${target_path}"
  tar -xzf $filename
  rm $filename
  cp -r ${platform}/* bin/
  chmod +x bin/garden
  rm -rf $platform
  cd $garden_root
  return 0
}

test_release() {
  # Mac doesn't have a timeout command so we alias to gtimeout (or exit if gtimeout is not installed).
  if [[ "$OSTYPE" == "darwin"* ]]; then
    if ! [ -x "$(command -v gtimeout)" ]; then
      echo "Command gtimeout is missing - You can install it with 'brew install gtimeout' on macOS"
      return 1
    else
      alias timeout=gtimeout
    fi
  fi

  if [ ! "$version" ]; then
    echo "Version is missing"
    return 1
  fi

  garden_release=${HOME}/.garden-release/bin/garden

  echo "→ Verify version"
  release_version=$(${garden_release} --version)

  echo $release_version

  if [ "$base_version" != "$release_version" ]; then
    echo "Versions don't match, ${version} and ${release_version}"
    return 1
  fi

  cd examples/demo-project
  echo ""
  echo "→ Running 'garden build' in demo project"
  echo ""
  ${garden_release} build
  echo ""
  echo "→ Running 'garden deploy' in demo project"
  echo ""
  ${garden_release} deploy
  echo ""
  echo ""
  echo "→ Running 'garden exec backend /bin/sh' in demo project"
  echo "→ Run a command in the prompt (ls, for example) and see if the TTY behaves as expected."
  echo ""
  ${garden_release} exec backend /bin/sh
  echo ""
  echo "→ Running 'garden create module' in demo project"
  echo "→ Respond to the prompts to see if the create command works"
  echo ""
  ${garden_release} create module

  cd ..
  cd vote
  echo ""
  echo "→ Running 'garden dev' in vote project - exits after 1 minute"
  echo "→ Try e.g. to update this file: ${garden_root}/examples/vote/vote/src/views/Home.vue"
  echo ""
  timeout 1m ${garden_release} dev

  echo ""
  echo "→ Running 'garden serve' in disabled-configs project - exits after 1 minute. Use the chance to test that the dashboard works."
  echo "→ The disabled module and test should be flagged appropriately on the Overview and Stack Graph pages."
  echo ""
  cd ..
  cd disabled-configs
  timeout 1m ${garden_release} serve

  # Remove the alias we set above
  if [[ "$OSTYPE" == "darwin"* ]]; then
    unalias timeout
  fi

  cd $garden_root
  echo "Done! Make sure to revert any changes that were made during the test run."
}

download_release
test_release
