#!/bin/sh
printf "Overwrite config? [y/N] "
read -r a
if [ "$a" = y ]; then
  echo "mode=fast" > app.conf && echo done
else
  echo aborted
fi
