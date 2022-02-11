FROM ubuntu:20.04

RUN apt update -y && DEBIAN_FRONTEND=noninteractive apt install -yq \
    curl git sudo python3 jq htop

SHELL ["/bin/bash", "-c"]

RUN useradd -ms /bin/bash candidate && \
    echo "candidate ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers

RUN mkdir -p /home/candidate/blackcandy/node_modules && \
  chown candidate:candidate /home/candidate/blackcandy/node_modules

VOLUME /home/candidate/blackcandy/node_modules

USER candidate
WORKDIR /home/candidate

RUN curl -O https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-sdk-372.0.0-linux-x86_64.tar.gz && \
    tar -xf google-cloud-sdk-372.0.0-linux-x86_64.tar.gz && \
    ./google-cloud-sdk/install.sh -q && \
    source ./google-cloud-sdk/path.bash.inc && \
    gcloud components install -q gke-gcloud-auth-plugin

RUN git clone https://github.com/asdf-vm/asdf.git ~/.asdf --branch v0.9.0 && \
    source ~/.asdf/asdf.sh &&  \
    asdf plugin add nodejs && \
    asdf install nodejs 16.14.0 && \
    asdf global nodejs 16.14.0 && \
    asdf plugin-add pulumi https://github.com/canha/asdf-pulumi.git && \
    asdf install pulumi 3.24.1 && \
    asdf global pulumi 3.24.1 && \
    asdf plugin add kubectl && \
    asdf install kubectl 1.23.3 && \
    asdf global kubectl 1.23.3

RUN echo "source $HOME/.asdf/asdf.sh" >> /home/candidate/.bashrc && \
  echo "source $HOME/google-cloud-sdk/path.bash.inc" >> /home/candidate/.bashrc